/**
 * Per-activity enforcement — the **decision** core (#98, Phase 8).
 *
 * After each telemetry pull/rollup the dashboard re-checks budgets
 * (`docs/architecture.md` → "Inbound — telemetry pull", step 4; the **Per-app
 * time quota (granular)** row of "Enforcement responsibilities"). This module
 * is the pure heart of that check: given the effective per-activity / per-group
 * quotas and the consumption rolled up over the same window, it decides which
 * targets have crossed their quota and should be stopped — applying a
 * **cool-down / hysteresis** so a flapping near-boundary sample doesn't fire on
 * every rollup.
 *
 * It *decides* only. Emitting `enforce.force_close` after the policy's grace
 * period and the SSH `pkill` fallback are **#99**; the WebSocket channel those
 * publish onto is **#100**. So this module deliberately has no dependency on
 * `events/` — it returns plain decision data those consumers read, carrying
 * `grace_seconds` through so #99 can schedule the force-close.
 *
 * License boundary: none touched — pure TypeScript over plain data.
 */

/** The targetable scopes for a per-activity quota (overall time is Timekpr's job). */
export type EnforcementScope = "activity" | "group";

/**
 * The cool-down map key for a `(scope, targetId)` target. A single string key
 * keeps the cool-down state a flat `Map` the caller can hold and persist.
 */
export function targetKey(scope: EnforcementScope, targetId: number): string {
  return `${scope}:${targetId}`;
}

/**
 * One effective quota and the consumption measured against it, both over the
 * same effective budget window. `allowedSeconds` is the resolver's effective
 * daily allowance (policy baseline + active grants); `consumedSeconds` is the
 * rolled-up usage. A target with no daily budget is *unlimited* and simply
 * isn't passed here.
 */
export interface QuotaConsumption {
  readonly scope: EnforcementScope;
  readonly targetId: number;
  readonly allowedSeconds: number;
  readonly consumedSeconds: number;
}

/** Inputs to {@link decideEnforcement}. All data is already loaded by the caller. */
export interface EnforcementDecisionInput {
  /** The evaluation instant (the rollup's reference time). */
  readonly now: Date;
  /**
   * The policy's grace period before the force-close lands, carried onto each
   * decision for #99 to honour. Not used by the decision itself.
   */
  readonly graceSeconds: number;
  /**
   * Suppress a re-fire for a target that fired less than this many seconds ago.
   * Hysteresis against a sample that hovers on the boundary across rollups.
   */
  readonly cooldownSeconds: number;
  /** The effective quotas + their consumption for this user, in any order. */
  readonly quotas: readonly QuotaConsumption[];
  /**
   * Per target ({@link targetKey}) the instant the dashboard last decided to
   * enforce it — the cool-down state from the previous evaluation. Empty on the
   * first run.
   */
  readonly lastFiredAt: ReadonlyMap<string, Date>;
}

/** A single "stop this target now" decision. */
export interface EnforcementDecision {
  readonly scope: EnforcementScope;
  readonly targetId: number;
  readonly allowedSeconds: number;
  readonly consumedSeconds: number;
  /** `consumedSeconds - allowedSeconds`, never negative. */
  readonly overageSeconds: number;
  /** The policy grace period #99 waits out before the force-close. */
  readonly graceSeconds: number;
}

/** The result of one evaluation: what to stop now, plus the next cool-down state. */
export interface EnforcementOutcome {
  /** Targets to enforce this round, ascending by `(scope, targetId)`. */
  readonly decisions: readonly EnforcementDecision[];
  /**
   * The cool-down state to carry into the next evaluation. Fired targets are
   * stamped with `now`; targets that have dropped back under quota are cleared
   * so a later re-exhaustion fires promptly; every other entry is preserved.
   */
  readonly lastFiredAt: ReadonlyMap<string, Date>;
}

/**
 * Is a quota exhausted? Consumption has reached (or passed) the allowance, and
 * there is actually usage to stop. The `consumedSeconds > 0` guard keeps a
 * `0/0` target — disallowed but idle — from firing with nothing running; a deny
 * *window* is the schedule layer's concern, not budget enforcement.
 */
function isExhausted(quota: QuotaConsumption): boolean {
  return quota.consumedSeconds > 0 && quota.consumedSeconds >= quota.allowedSeconds;
}

/**
 * Decide which per-activity / per-group quotas to enforce this round.
 *
 * Pure: no I/O, no clock read (the caller passes `now`). The cool-down state is
 * threaded in via `lastFiredAt` and returned in {@link EnforcementOutcome} so
 * the caller (the telemetry scheduler, #117) can hold it across rollups without
 * this module owning storage.
 */
export function decideEnforcement(input: EnforcementDecisionInput): EnforcementOutcome {
  const nowMs = input.now.getTime();
  const cooldownMs = input.cooldownSeconds * 1000;
  const nextFired = new Map(input.lastFiredAt);
  const decisions: EnforcementDecision[] = [];

  for (const quota of input.quotas) {
    const key = targetKey(quota.scope, quota.targetId);

    if (!isExhausted(quota)) {
      // Back under the line (window rolled over, or a grant topped it up):
      // forget the cool-down so the next exhaustion isn't suppressed.
      nextFired.delete(key);
      continue;
    }

    const last = nextFired.get(key);
    if (last !== undefined && nowMs - last.getTime() < cooldownMs) {
      // Still cooling down from a recent decision — keep the timestamp, skip.
      continue;
    }

    decisions.push({
      scope: quota.scope,
      targetId: quota.targetId,
      allowedSeconds: quota.allowedSeconds,
      consumedSeconds: quota.consumedSeconds,
      overageSeconds: quota.consumedSeconds - quota.allowedSeconds,
      graceSeconds: input.graceSeconds,
    });
    nextFired.set(key, input.now);
  }

  decisions.sort((a, b) => a.scope.localeCompare(b.scope) || a.targetId - b.targetId);
  return { decisions, lastFiredAt: nextFired };
}
