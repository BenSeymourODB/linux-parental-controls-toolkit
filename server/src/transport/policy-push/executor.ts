/**
 * The live policy-push {@link ActionExecutor} (#201, Phase 4) — now the
 * **platform-agnostic dispatcher** in front of the per-platform runners (#232).
 *
 * This is the concrete executor the offline queue (#84) was built against: given
 * one `policy.push` action — the {@link import("./platform-runner.js").PolicyEnforcementContext}
 * a CRUD mutation computed, adapted by {@link queuedActionFromPolicyPush} — it
 * loads the affected `(client, user)` rows, runs the platform-agnostic no-op
 * branches, then selects the {@link import("./platform-runner.js").PlatformPolicyRunner}
 * for the client's declared `platform` and delegates the actual enforcement to
 * it. `pushOrEnqueue` (the live call site) and `drainClient` (the replay loop)
 * both drive this same executor, so an online push and an offline replay run
 * identical code.
 *
 * The platform seam (#232): rather than baking in "every client is Linux", the
 * runner is chosen by `client.platform` (`Client.platform`, #229) from the
 * injected {@link PlatformRunnerRegistry}. The Linux runner (`./linux-runner.ts`,
 * `timekpra`-over-SSH) is the only registration today; a future
 * `WindowsAgentRunner` is additive. Selection is exact-match — a client whose
 * platform has no registered runner is a **warn-and-no-op** (a `windows` client
 * today is known-not-yet-supported, not a command failure to dead-letter), not
 * silently coerced onto the Linux path. The runner owns *both* the normal push
 * (`enforce`) and the unlink unmanage push (`unmanage`, #253).
 *
 * **No-op branches** (resolve to nothing to push, never an error):
 * - a **client-scoped** change (`userId === null`): per-user enforcement only;
 * - a **missing client** (deleted before replay);
 * - a **client on an unsupported platform** (no registered runner);
 * - a **missing `(user, client)` link** that is *not* an explicit unlink — e.g.
 *   a user-scoped edit for a user since unlinked from this client: there is
 *   nothing left to enforce here.
 *
 * **Unmanage branch** (#253): a `link.deleted` action whose `detail` carries the
 * `os_username` the route captured before the link cascaded away. The link row
 * is gone, but the dashboard still owes the client one push — the runner pushes
 * the fully-unrestricted config (`unmanage`) so a now-unlinked account isn't left
 * enforced by whatever limits/allowed-hours were last pushed.
 *
 * Errors from the selected runner propagate unchanged so the queue classifies
 * them: an `SshUnreachableError`/timeout (retriable) keeps the action queued for
 * replay; an `SshCommandError`/`TimekprArgumentError` (non-retriable) is
 * surfaced to the caller (online) or dead-lettered (replay).
 *
 * License boundary: none touched — orchestration over Drizzle + the injected
 * platform runner(s); the Linux runner execs over the existing SSH subprocess
 * facade. No GPL code is linked in-process (`CLAUDE.md` → "License boundaries").
 */
import { z } from "zod";

import type { PolicyDb } from "../../policy/db.js";
import {
  gatherUserBudgets,
  gatherUserExceptions,
  gatherUserScheduleRules,
} from "../../policy/group-resolution.js";
import { getClient, getUser, listUserLinks } from "../../policy/repository.js";
import type { ActionExecutor, QueuedAction } from "../queue/types.js";
import { policyPushPayloadSchema } from "./payload.js";
import type { PlatformRunnerRegistry } from "./platform-runner.js";

/** The push reason that marks an explicit user↔client unlink (#253). */
const LINK_DELETED_REASON = "link.deleted";

/**
 * The `link.deleted` detail the route attaches: the OS account name captured
 * before the link row cascaded away. Validated here because a queued payload is
 * external-at-rest (`CLAUDE.md` → "Validate all external input"); a row without
 * a usable name skips the unmanage push rather than throwing.
 */
const unlinkDetailSchema = z.object({ osUsername: z.string().min(1) });

// The `timekpra` client surface + factory now live with the Linux runner; the
// re-exports keep `bootstrap.ts` and existing importers' paths unchanged.
export type {
  PolicyPushClient,
  PolicyPushClientFactory,
  PolicyPushClientTarget,
} from "./linux-runner.js";

/** The slice of a logger the executor uses (for the unsupported-platform skip). */
export interface PolicyPushExecutorLogger {
  warn(obj: object, msg: string): void;
}

/** Construction options for {@link createPolicyPushExecutor}. */
export interface PolicyPushExecutorOptions {
  /** The shared policy-store handle the affected rows are read from. */
  readonly db: PolicyDb;
  /** Per-platform runners, keyed by `Client.platform`. Linux is the default. */
  readonly registry: PlatformRunnerRegistry;
  /** Server-default timezone for users with no `tz` override. */
  readonly defaultTz: string;
  /** Optional logger; records the unsupported-platform skip (see below). */
  readonly log?: PolicyPushExecutorLogger;
  /** Clock for the reference instant; overridable in tests. Defaults to `new Date()`. */
  readonly now?: () => Date;
  /**
   * When `true`, the effective push also composes the user's active
   * date-specific exceptions (own + inherited group, `gatherUserExceptions`,
   * ADR 0012 precedence) into the allowed-hours grid — the #399 date-override
   * enforcement push. The standing push leaves this `false` (the default) so the
   * recurring `timekpra` grid stays exception-free (ADR 0012 §3). Because the
   * executor re-resolves from the DB on every run, a queued override replayed
   * after its window has closed simply resolves to the standing grid — the
   * revert is automatic.
   */
  readonly includeExceptions?: boolean;
}

/**
 * Build the live policy-push {@link ActionExecutor}. The returned executor is
 * idempotent (the runners assert desired state, not a delta), as the
 * at-least-once queue contract requires.
 */
export function createPolicyPushExecutor(options: PolicyPushExecutorOptions): ActionExecutor {
  const { db, registry, defaultTz, log } = options;
  const now = options.now ?? ((): Date => new Date());
  const includeExceptions = options.includeExceptions ?? false;

  return async function execute(action: QueuedAction): Promise<void> {
    const { userId, reason, detail } = policyPushPayloadSchema.parse(action.payload);

    // Client-scoped change (e.g. a client record renamed): nothing per-user to push.
    if (userId === null) return;

    // The client may have been deleted between enqueue and replay.
    const client = getClient(db, action.clientId);
    if (client === undefined) return;

    // The platform seam (#232): pick the runner for this client's platform — it
    // owns both the enforce and unmanage pushes below. No runner registered (a
    // `windows` client today) → warn + no-op rather than pushing the Linux
    // `timekpra` path to a non-Linux box.
    const runner = registry.resolve(client.platform);
    if (runner === undefined) {
      log?.warn(
        { clientId: action.clientId, userId, platform: client.platform },
        "no transport runner registered for client platform; policy push skipped (Linux is the only supported platform today, #232)",
      );
      return;
    }

    // Resolve the supervised account on this client.
    const link = listUserLinks(db, userId).find((l) => l.clientId === action.clientId);
    if (link === undefined) {
      // The link is gone. An explicit unlink (`link.deleted`) still owes the
      // client one *unmanage* push: lift this user's limits back to unrestricted,
      // using the username the route captured before the row cascaded away
      // (#253). Any other missing-link case has nothing to do.
      if (reason !== LINK_DELETED_REASON) return;
      const unlink = unlinkDetailSchema.safeParse(detail);
      if (!unlink.success) return;
      await runner.unmanage({ client, username: unlink.data.osUsername, userId, reason });
      return;
    }

    // The link's existence guarantees the user row exists (the link FK-cascades
    // away with the user), so `getUser` is effectively non-null here; `?.` is
    // defensive only, and a vanished user resolves to an empty-policy push.
    const user = getUser(db, userId);
    const tz = user?.tz ?? defaultTz;
    // Effective policy = the user's own rules merged with any inherited group
    // schedules/budgets (#362), so a group-targeted bedtime or budget actually
    // reaches the client instead of being display-only.
    const budgets = gatherUserBudgets(db, userId);
    const schedules = gatherUserScheduleRules(db, userId);
    // The date-override push (#399) folds active exceptions into the allowed-hours
    // grid; the standing push omits them so the recurring grid stays
    // exception-free (ADR 0012 §3). Re-read here so a queued override replayed
    // after its window closed resolves to the standing grid (auto-revert).
    const exceptions = includeExceptions ? gatherUserExceptions(db, userId) : undefined;

    await runner.enforce({
      client,
      username: link.osUsername,
      userId,
      reason,
      tz,
      schedules,
      budgets,
      now: now(),
      ...(exceptions !== undefined ? { exceptions } : {}),
    });
  };
}
