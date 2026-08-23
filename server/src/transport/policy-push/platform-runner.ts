/**
 * The platform-keyed runner seam for live policy push (#232).
 *
 * The dashboard supervises a fleet of clients that are *Linux today* but need
 * not be forever (`docs/windows-client-support.md` → "Modularity tweaks to make
 * cheaply now", item 6; `Client.platform` from #229). This module is the seam
 * that keeps the per-client dispatch from baking in "every client is Linux":
 * the {@link import("./executor.js").createPolicyPushExecutor live executor}
 * resolves a platform-agnostic {@link PolicyEnforcementContext} for one push and
 * then delegates to the {@link PlatformPolicyRunner} registered for that
 * client's {@link import("../../policy/enums.js").Platform}. The Linux runner
 * (`./linux-runner.ts`, `timekpra`-over-SSH) is the only registration today; a
 * future `WindowsAgentRunner` is purely additive — register it beside the Linux
 * runner and no call site changes.
 *
 * Selection is **exact-match**, not "default to Linux for anything unknown": the
 * point of the seam is to stop treating every client as Linux, so pushing
 * `timekpra` to a non-Linux box would be the very bug this prevents. A client
 * whose platform has no registered runner is handled by the executor as a
 * warn-and-no-op (see there), not silently coerced onto the Linux path.
 *
 * License boundary: none touched — this is a pure in-process dispatch table over
 * the existing runner(s); the Linux runner still execs `timekpra` over the SSH
 * subprocess facade. No GPL code is linked in-process (`CLAUDE.md` → "License
 * boundaries").
 */
import type { Platform } from "../../policy/enums.js";
import type { ClientRow } from "../../policy/repository.js";
import type { BudgetInput, ExceptionInput } from "../../policy/resolve.js";
import type { ScheduleRule } from "../../policy/schedule-precedence.js";

/**
 * The platform-agnostic inputs for one `(client, user)` policy push, resolved by
 * the executor before it picks a runner. A {@link PlatformPolicyRunner} turns
 * this into platform-specific enforcement (the Linux runner resolves it to the
 * `timekpra` limits/allowed-hours and pushes over SSH).
 */
export interface PolicyEnforcementContext {
  /** The enrolled client the push targets (carries `platform`, addressing). */
  readonly client: ClientRow;
  /** The supervised OS account to act on (from the user↔client link). */
  readonly username: string;
  /** The affected supervised user's id (audit attribution). */
  readonly userId: number;
  /** The mutation reason that triggered the push (audit attribution). */
  readonly reason: string;
  /** The user's effective timezone (`User.tz ?? PCT_DEFAULT_TZ`). */
  readonly tz: string;
  /**
   * The user's effective schedule rules — own rules merged with inherited group
   * rules in precedence order by the gatherer (#362); the runner forwards them
   * to `resolvePolicyPush`, which applies first-match-wins.
   */
  readonly schedules: readonly ScheduleRule[];
  /**
   * The user's effective budgets — own budgets plus any inherited group budget
   * for a slot the user has not overridden (#362), overall + per-activity.
   */
  readonly budgets: readonly BudgetInput[];
  /** The reference instant the week and "today" are resolved against. */
  readonly now: Date;
  /**
   * The user's active date-specific overrides (#399), in precedence order.
   * Optional — the standing push omits it (the recurring grid stays
   * exception-free, ADR 0012 §3); the date-override enforcement push supplies
   * the user's own + inherited group exceptions so the runner folds them into
   * the allowed-hours grid it pushes.
   */
  readonly exceptions?: readonly ExceptionInput[];
}

/**
 * The inputs to *unmanage* one supervised account on a client (#253): lift its
 * enforcement back to unrestricted after the user↔client link was deleted. There
 * are no policy rows to resolve (the link is gone) — just the account to address
 * and the audit attribution; the runner pushes a fixed unrestricted config.
 */
export interface PolicyUnmanageContext {
  /** The enrolled client the unmanage push targets. */
  readonly client: ClientRow;
  /** The OS account to lift limits from (captured before the link cascaded away). */
  readonly username: string;
  /** The affected supervised user's id (audit attribution). */
  readonly userId: number;
  /** The mutation reason that triggered the push (audit attribution). */
  readonly reason: string;
}

/**
 * Enforces an effective policy on one client of a given platform. The executor
 * holds the platform-agnostic plumbing (load rows, run the no-op branches, pick
 * the runner); each runner owns the platform-specific translation + push, for
 * both the normal push (`enforce`) and the unlink unmanage push (`unmanage`).
 */
export interface PlatformPolicyRunner {
  /** The {@link Platform} this runner enforces (its registry key). */
  readonly platform: Platform;
  /** Push the resolved effective policy to the client. */
  enforce(ctx: PolicyEnforcementContext): Promise<void>;
  /** Lift the account's enforcement back to unrestricted after an unlink (#253). */
  unmanage(ctx: PolicyUnmanageContext): Promise<void>;
}

/** A read-only lookup from {@link Platform} to its {@link PlatformPolicyRunner}. */
export interface PlatformRunnerRegistry {
  /** The runner for `platform`, or `undefined` when none is registered. */
  resolve(platform: Platform): PlatformPolicyRunner | undefined;
  /** The platforms that have a registered runner (for diagnostics/tests). */
  readonly platforms: readonly Platform[];
}

/**
 * Build a {@link PlatformRunnerRegistry} from a set of runners. Throws on a
 * duplicate platform registration — two runners claiming the same platform is a
 * wiring bug (which would silently win is undefined), not a recoverable state.
 */
export function createPlatformRunnerRegistry(
  runners: readonly PlatformPolicyRunner[],
): PlatformRunnerRegistry {
  const byPlatform = new Map<Platform, PlatformPolicyRunner>();
  for (const runner of runners) {
    if (byPlatform.has(runner.platform)) {
      throw new Error(`duplicate transport runner registered for platform "${runner.platform}"`);
    }
    byPlatform.set(runner.platform, runner);
  }
  return {
    resolve: (platform) => byPlatform.get(platform),
    platforms: [...byPlatform.keys()],
  };
}
