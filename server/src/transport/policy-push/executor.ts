/**
 * The live policy-push {@link ActionExecutor} (#201, Phase 4).
 *
 * This is the concrete executor the offline queue (#84) was built against: given
 * one `policy.push` action — the {@link import("../stub.js").PolicyPushCommand}
 * a CRUD mutation computed, adapted by {@link queuedActionFromPolicyPush} — it
 * recomputes the affected user's effective overall policy for the target client
 * and pushes it over the SSH + `timekpra` transport. `pushOrEnqueue` (the live
 * call site) and `drainClient` (the replay loop) both drive this same executor,
 * so an online push and an offline replay run identical code.
 *
 * The `timekpra` client is supplied by an injected {@link PolicyPushClientFactory}
 * so this module is unit-testable without SSH and stays decoupled from the
 * concrete transport/credentials/audit wiring (assembled in `./bootstrap.ts`):
 * production builds a real {@link import("../timekpr/client.js").TimekprClient}
 * over the audited SSH facade; a test passes a recording fake.
 *
 * **No-op branches** (resolve to nothing to push, never an error):
 * - a **client-scoped** change (`userId === null`): `timekpra` is per-user;
 * - a **missing client** (deleted before replay);
 * - a **missing `(user, client)` link** (e.g. `link.deleted`): the
 *   `linux_username` can't be resolved and there is nothing left to enforce.
 *
 * Errors propagate the SSH taxonomy unchanged so the queue classifies them: an
 * `SshUnreachableError`/timeout (retriable) keeps the action queued for replay;
 * an `SshCommandError`/`TimekprArgumentError` (non-retriable) is surfaced to the
 * caller (online) or dead-lettered (replay). Auditing is automatic — the
 * injected client runs over the {@link import("../audit/transport.js").AuditingTransport}.
 *
 * License boundary: none touched — orchestration over Drizzle + the injected
 * `timekpra` client, which execs over the existing SSH subprocess facade. No GPL
 * code is linked in-process (`CLAUDE.md` → "License boundaries").
 */
import type { PolicyDb } from "../../policy/db.js";
import {
  getClient,
  getUser,
  listUserBudgets,
  listUserLinks,
  listUserSchedules,
  type ClientRow,
} from "../../policy/repository.js";
import type { WeeklyAllowedWindows } from "../timekpr/allowed-hours.js";
import type { ActionExecutor, QueuedAction } from "../queue/types.js";
import { policyPushPayloadSchema } from "./payload.js";
import { resolvePolicyPush } from "./resolve.js";

/**
 * The slice of {@link import("../timekpr/client.js").TimekprClient} the executor
 * drives. Declared structurally so the real client satisfies it and a test can
 * pass a recording fake without an `as` cast — the same pattern as
 * `TimekprTransport`. The setters return the transport's `ExecResult`(s); typed
 * as `unknown` here because the executor only awaits them for ordering/failure.
 */
export interface PolicyPushClient {
  setTimeLimits(perDaySeconds: readonly number[]): Promise<unknown>;
  setTimeLimitWeek(seconds: number): Promise<unknown>;
  setTimeLimitMonth(seconds: number): Promise<unknown>;
  setWeeklyAllowedHours(weekly: WeeklyAllowedWindows): Promise<unknown>;
}

/** Attribution + addressing for the {@link PolicyPushClientFactory}. */
export interface PolicyPushClientTarget {
  /** The enrolled client the commands are dispatched to. */
  readonly client: ClientRow;
  /** The supervised Linux account `timekpra` acts on (from the user↔client link). */
  readonly username: string;
  /** The affected supervised user's id (audit attribution). */
  readonly userId: number;
  /** The mutation reason that triggered the push (audit attribution). */
  readonly reason: string;
}

/**
 * Builds the {@link PolicyPushClient} for one (client, user) push. Production
 * returns a `TimekprClient` over the audited SSH transport bound to the client's
 * {@link import("../ssh/facade.js").SshTarget}; tests return a recording fake.
 */
export type PolicyPushClientFactory = (target: PolicyPushClientTarget) => PolicyPushClient;

/** The slice of a logger the executor uses (for the full-lockout skip notice). */
export interface PolicyPushExecutorLogger {
  warn(obj: object, msg: string): void;
}

/** Construction options for {@link createPolicyPushExecutor}. */
export interface PolicyPushExecutorOptions {
  /** The shared policy-store handle the affected rows are read from. */
  readonly db: PolicyDb;
  /** Builds the `timekpra` client for one push (the SSH/credentials/audit seam). */
  readonly buildClient: PolicyPushClientFactory;
  /** Server-default timezone for users with no `tz` override. */
  readonly defaultTz: string;
  /** Optional logger; records the full-lockout allowed-hours skip (see below). */
  readonly log?: PolicyPushExecutorLogger;
  /** Clock for the reference instant; overridable in tests. Defaults to `new Date()`. */
  readonly now?: () => Date;
}

/**
 * Build the live policy-push {@link ActionExecutor}. The returned executor is
 * idempotent (the `timekpra` setters assert desired state, not a delta), as the
 * at-least-once queue contract requires.
 */
export function createPolicyPushExecutor(options: PolicyPushExecutorOptions): ActionExecutor {
  const { db, buildClient, defaultTz, log } = options;
  const now = options.now ?? ((): Date => new Date());

  return async function execute(action: QueuedAction): Promise<void> {
    const { userId, reason } = policyPushPayloadSchema.parse(action.payload);

    // Client-scoped change (e.g. a client record renamed): nothing per-user to push.
    if (userId === null) return;

    // The client may have been deleted between enqueue and replay.
    const client = getClient(db, action.clientId);
    if (client === undefined) return;

    // Resolve the supervised account on this client; if the link is gone
    // (e.g. link.deleted), there is no username to act on and nothing to enforce.
    const link = listUserLinks(db, userId).find((l) => l.clientId === action.clientId);
    if (link === undefined) return;

    // The link's existence guarantees the user row exists (the link FK-cascades
    // away with the user), so `getUser` is effectively non-null here; `?.` is
    // defensive only, and a vanished user resolves to an empty-policy push.
    const user = getUser(db, userId);
    const tz = user?.tz ?? defaultTz;
    const budgets = listUserBudgets(db, userId);
    const schedules = listUserSchedules(db, userId);

    const resolved = resolvePolicyPush({ tz, schedules, budgets, now: now() });

    const timekpr = buildClient({ client, username: link.linuxUsername, userId, reason });

    if (resolved.perWeekdaySeconds !== null) {
      await timekpr.setTimeLimits(resolved.perWeekdaySeconds);
    }
    if (resolved.weeklySeconds !== null) {
      await timekpr.setTimeLimitWeek(resolved.weeklySeconds);
    }
    if (resolved.monthlySeconds !== null) {
      await timekpr.setTimeLimitMonth(resolved.monthlySeconds);
    }

    // A fully-denied week has no allowed weekday, which `timekpra` allowed-hours
    // cannot represent (`--setalloweddays` rejects an empty set). Pushing it
    // would throw a *non-retriable* error and dead-letter the whole action —
    // silently dropping the limits above too. Full lockout is enforced via a
    // zero daily limit / session-kill (Phase 8c), not allowed-hours, so skip
    // the allowed-hours push here and surface the gap rather than failing.
    if ([...resolved.weekly.values()].some((windows) => windows.length > 0)) {
      await timekpr.setWeeklyAllowedHours(resolved.weekly);
    } else {
      log?.warn(
        { clientId: action.clientId, userId },
        "policy denies all access all week; allowed-hours push skipped (full lockout is Phase 8c: zero daily limit / session-kill, not allowed-hours)",
      );
    }
  };
}
