/**
 * The Linux {@link PlatformPolicyRunner} (#232) — the `timekpra`-over-SSH
 * enforcement that *was* the body of {@link import("./executor.js")} before the
 * platform seam was extracted. It is the default (and today only) registration
 * in the {@link import("./platform-runner.js").PlatformRunnerRegistry}; the
 * executor selects it for every `platform: "linux"` client (the schema default,
 * so every real client today).
 *
 * Given the platform-agnostic {@link PolicyEnforcementContext} the executor
 * resolved, it recomputes the user's effective overall `timekpra` inputs
 * ({@link resolvePolicyPush}) and drives the setters. The `timekpra` client is
 * supplied by an injected {@link PolicyPushClientFactory} so this module is
 * unit-testable without SSH and stays decoupled from the concrete
 * transport/credentials/audit wiring (assembled in `./bootstrap.ts`).
 *
 * Errors propagate the SSH taxonomy unchanged so the offline queue classifies
 * them (retriable → keep queued; non-retriable → dead-letter), exactly as
 * before the extraction.
 *
 * License boundary: none touched — orchestration over Drizzle + the injected
 * `timekpra` client, which execs over the existing SSH subprocess facade. No GPL
 * code is linked in-process (`CLAUDE.md` → "License boundaries").
 */
import type { ClientRow } from "../../policy/repository.js";
import type { WeeklyAllowedWindows } from "../timekpr/allowed-hours.js";
import type {
  PlatformPolicyRunner,
  PolicyEnforcementContext,
  PolicyUnmanageContext,
} from "./platform-runner.js";
import { resolvePolicyPush, unrestrictedPolicyPush, type ResolvedPolicyPush } from "./resolve.js";

/**
 * The slice of {@link import("../timekpr/client.js").TimekprClient} the Linux
 * runner drives. Declared structurally so the real client satisfies it and a
 * test can pass a recording fake without an `as` cast. The setters return the
 * transport's `ExecResult`(s); typed as `unknown` here because the runner only
 * awaits them for ordering/failure.
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

/** The slice of a logger the Linux runner uses (for the full-lockout skip notice). */
export interface PolicyPushRunnerLogger {
  warn(obj: object, msg: string): void;
}

/** Construction options for {@link createLinuxPolicyRunner}. */
export interface LinuxPolicyRunnerOptions {
  /** Builds the `timekpra` client for one push (the SSH/credentials/audit seam). */
  readonly buildClient: PolicyPushClientFactory;
  /** Optional logger; records the full-lockout allowed-hours skip (see below). */
  readonly log?: PolicyPushRunnerLogger;
}

/**
 * Build the Linux {@link PlatformPolicyRunner}. Idempotent (the `timekpra`
 * setters assert desired state, not a delta), as the at-least-once queue
 * contract requires.
 */
export function createLinuxPolicyRunner(options: LinuxPolicyRunnerOptions): PlatformPolicyRunner {
  const { buildClient, log } = options;

  /**
   * Drive one {@link ResolvedPolicyPush} through the `timekpra` setters, in
   * order. Shared by the normal `enforce` push and the `unmanage` unlink push so
   * both apply limits identically and idempotently.
   */
  async function applyResolvedPush(
    timekpr: PolicyPushClient,
    resolved: ResolvedPolicyPush,
    clientId: number,
    userId: number,
  ): Promise<void> {
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
    // (The unmanage push is all-hours-every-day, so it never takes this branch.)
    if ([...resolved.weekly.values()].some((windows) => windows.length > 0)) {
      await timekpr.setWeeklyAllowedHours(resolved.weekly);
    } else {
      log?.warn(
        { clientId, userId },
        "policy denies all access all week; allowed-hours push skipped (full lockout is Phase 8c: zero daily limit / session-kill, not allowed-hours)",
      );
    }
  }

  return {
    platform: "linux",
    async enforce(ctx: PolicyEnforcementContext): Promise<void> {
      const resolved = resolvePolicyPush({
        tz: ctx.tz,
        schedules: ctx.schedules,
        budgets: ctx.budgets,
        now: ctx.now,
        // Fold in date-specific overrides when the executor supplies them (#399);
        // the standing push omits `exceptions`, keeping the recurring grid
        // exception-free (ADR 0012 §3).
        ...(ctx.exceptions !== undefined ? { exceptions: ctx.exceptions } : {}),
      });
      const timekpr = buildClient({
        client: ctx.client,
        username: ctx.username,
        userId: ctx.userId,
        reason: ctx.reason,
      });
      await applyResolvedPush(timekpr, resolved, ctx.client.id, ctx.userId);
    },
    async unmanage(ctx: PolicyUnmanageContext): Promise<void> {
      const timekpr = buildClient({
        client: ctx.client,
        username: ctx.username,
        userId: ctx.userId,
        reason: ctx.reason,
      });
      await applyResolvedPush(timekpr, unrestrictedPolicyPush(), ctx.client.id, ctx.userId);
    },
  };
}
