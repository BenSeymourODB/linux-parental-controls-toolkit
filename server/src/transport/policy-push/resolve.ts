/**
 * Resolve a user's effective overall-session policy into the concrete
 * `timekpra` push inputs (#201, Phase 4).
 *
 * This is the pure, I/O-free bridge between the policy model and the
 * {@link import("../timekpr/client.js").TimekprClient} setters the live push
 * (`./executor.ts`) drives. It composes the two existing translation layers:
 *
 * - the effective-policy resolver (#143, {@link import("../../policy/resolve.js")})
 *   for the daily overall limit, and
 * - the weekly recurring-window bridge (#140,
 *   {@link import("../../policy/weekly-windows.js")}) for the allowed-days/hours grid.
 *
 * Weekly/monthly rolling limits are read straight from the `overall` budgets:
 * the resolver only models the *daily* allowance (a grant on an unlimited base
 * is moot), and weekly/monthly grants are not modelled, so summing the
 * `overall` budgets for those windows is the whole story today.
 *
 * **Scope of this slice.** Overall session limits + the recurring allowed-hours
 * grid — exactly Phase 4's "dashboard pushes overall session limits". Grants
 * are resolved as `[]` here (the grant-driven recompute push is #117); PlayTime
 * / per-activity limits are Phase 8 (#99); weekday-varying budgets (#141) would
 * turn the single daily resolve below into a per-weekday one without changing
 * this contract.
 *
 * License boundary: none touched — pure TypeScript over the policy model.
 */
import { localCalendarDate } from "../../policy/budget-window.js";
import { effectivePolicy, type BudgetInput } from "../../policy/resolve.js";
import type { ScheduleRule } from "../../policy/schedule-precedence.js";
import { resolveWeeklyAllowedWindows } from "../../policy/weekly-windows.js";
import type { WeeklyAllowedWindows } from "../timekpr/allowed-hours.js";

/** Number of weekdays in the per-day `--settimelimits` list (Mon..Sun). */
const DAYS_PER_WEEK = 7;

/** Inputs to {@link resolvePolicyPush}; all rows already loaded for the user. */
export interface PolicyPushResolveInput {
  /** The user's effective timezone (`User.tz ?? PCT_DEFAULT_TZ`). */
  readonly tz: string;
  /** The user's schedule rules (precedence order is applied by the resolver). */
  readonly schedules: readonly ScheduleRule[];
  /** The user's budgets (overall + per-activity; only overall is pushed here). */
  readonly budgets: readonly BudgetInput[];
  /** The reference instant the week and "today" are resolved against. */
  readonly now: Date;
}

/** The concrete `timekpra` push inputs for one user on one client. */
export interface ResolvedPolicyPush {
  /**
   * Per-ISO-weekday daily overall limit in seconds (Mon..Sun), for
   * `--settimelimits`; `null` when no daily overall budget exists (no daily
   * limit to push).
   */
  readonly perWeekdaySeconds: number[] | null;
  /** Rolling weekly overall limit in seconds, or `null` when none is defined. */
  readonly weeklySeconds: number | null;
  /** Rolling monthly overall limit in seconds, or `null` when none is defined. */
  readonly monthlySeconds: number | null;
  /** The recurring allowed-access grid for `--setalloweddays`/`--setallowedhours`. */
  readonly weekly: WeeklyAllowedWindows;
}

/** Sum the `secondsAllowed` of every `overall` budget in the given window, or `null` if none. */
function rollingOverallSeconds(
  budgets: readonly BudgetInput[],
  window: "weekly" | "monthly",
): number | null {
  const matching = budgets.filter((b) => b.scope === "overall" && b.window === window);
  if (matching.length === 0) return null;
  return matching.reduce((sum, b) => sum + b.secondsAllowed, 0);
}

/**
 * Resolve the user's effective overall policy into the {@link ResolvedPolicyPush}
 * the live push hands to a {@link import("../timekpr/client.js").TimekprClient}.
 *
 * The daily overall limit comes from the resolver (so the one "what applies on
 * day D" computation is the single source); it is currently weekday-uniform (no
 * weekday-varying budgets yet, #141), so the resolved daily value is replicated
 * across all seven days of the `--settimelimits` list.
 */
export function resolvePolicyPush(input: PolicyPushResolveInput): ResolvedPolicyPush {
  const { tz, schedules, budgets, now } = input;

  const weekly = resolveWeeklyAllowedWindows({ schedules, tz, reference: now });

  const today = localCalendarDate(now, tz);
  const dailyOverall = effectivePolicy({
    date: today,
    tz,
    schedules,
    budgets,
    grants: [],
  }).overallSeconds;
  const perWeekdaySeconds =
    dailyOverall === null ? null : Array.from({ length: DAYS_PER_WEEK }, () => dailyOverall);

  return {
    perWeekdaySeconds,
    weeklySeconds: rollingOverallSeconds(budgets, "weekly"),
    monthlySeconds: rollingOverallSeconds(budgets, "monthly"),
    weekly,
  };
}
