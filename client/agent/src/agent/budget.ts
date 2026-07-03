/**
 * The agent's locally-cached budgets (#103, Phase 8b).
 *
 * `docs/client-notifications.md` → Components/2: the agent "holds the locally
 * cached budget + `NotificationPolicy`" and uses "the locally cached budget
 * total (last pushed by the server) plus the local usage stream from
 * `aw-server` to compute 'time remaining' without needing the server to be
 * reachable." This module is the cache half of that: the per-budget totals the
 * agent warns against, mutated additively by grants.
 *
 * The authoritative totals are pushed over the SSH policy transport (a
 * `policy.changed` event is only a nudge to re-pull); a `grant.applied` event
 * carries its own delta and is applied here immediately so the countdown reacts
 * without waiting for the next policy pull. Both keep the cache the single local
 * source of "how much time does this budget have".
 *
 * License boundary: none touched — plain TypeScript.
 */

/** The overall device screen-time budget's stable cache key. */
export const OVERALL_BUDGET_KEY = "overall";

/** Stable per-budget key: `overall` for screen time, `activity:<id>` otherwise. */
export function budgetKey(activityId: number | null): string {
  return activityId === null ? OVERALL_BUDGET_KEY : `activity:${activityId}`;
}

/** One cached budget the agent tracks a countdown for. */
export interface CachedBudget {
  /** {@link budgetKey} of this budget. */
  key: string;
  /** Human label for toasts ("overall screen time", "YouTube"). */
  label: string;
  /** The targeted activity, or `null` for the overall screen-time budget. */
  activityId: number | null;
  /** Effective total for the current window in seconds (policy + grants). */
  totalSeconds: number;
}

/** Remaining seconds for a budget given usage so far, clamped to `≥ 0`. */
export function remainingSeconds(totalSeconds: number, usedSeconds: number): number {
  return Math.max(0, Math.floor(totalSeconds) - Math.floor(usedSeconds));
}

/**
 * The set of budgets the agent is currently warning against, keyed by
 * {@link budgetKey}. Replaced wholesale on a policy pull ({@link replace}) and
 * mutated additively by grants ({@link applyGrant}).
 */
export class BudgetCache {
  readonly #byKey = new Map<string, CachedBudget>();

  constructor(initial: readonly CachedBudget[] = []) {
    this.replace(initial);
  }

  /** Replace the whole set (a fresh policy snapshot). */
  replace(budgets: readonly CachedBudget[]): void {
    this.#byKey.clear();
    for (const budget of budgets) this.#byKey.set(budget.key, { ...budget });
  }

  /** The current budgets, in insertion order. */
  list(): CachedBudget[] {
    return [...this.#byKey.values()].map((b) => ({ ...b }));
  }

  /** The budget for a key, or `undefined` if not cached. */
  get(key: string): CachedBudget | undefined {
    const budget = this.#byKey.get(key);
    return budget ? { ...budget } : undefined;
  }

  /**
   * Add `grantedSeconds` to the budget targeted by `activityId` (or the overall
   * budget when `null`). Returns the updated budget, or `null` if that budget
   * is not cached — a grant for a budget the agent doesn't know about is a
   * no-op the caller logs (the next policy pull reconciles it).
   */
  applyGrant(activityId: number | null, grantedSeconds: number): CachedBudget | null {
    const key = budgetKey(activityId);
    const budget = this.#byKey.get(key);
    if (budget === undefined) return null;
    const updated: CachedBudget = {
      ...budget,
      totalSeconds: budget.totalSeconds + Math.max(0, Math.floor(grantedSeconds)),
    };
    this.#byKey.set(key, updated);
    return { ...updated };
  }
}
