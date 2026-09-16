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
 * / per-activity limits are Phase 8 (#99). Weekday-varying budgets (#141, ADR
 * 0013) are resolved per weekday below via
 * {@link import("../../policy/resolve.js").overallDailySecondsForWeekday}, so a
 * "2h weekdays / 4h weekends" budget reaches the seven-day `--settimelimits`
 * list — without changing this contract.
 *
 * License boundary: none touched — pure TypeScript over the policy model.
 */
import {
  overallDailySecondsForWeekday,
  type BudgetInput,
  type ExceptionInput,
} from "../../policy/resolve.js";
import type { ScheduleRule } from "../../policy/schedule-precedence.js";
import { resolveWeeklyAllowedWindows } from "../../policy/weekly-windows.js";
import type { TimeWindow, WeeklyAllowedWindows } from "../timekpr/allowed-hours.js";
import type { IsoWeekday } from "../timekpr/commands.js";

/** Number of weekdays in the per-day `--settimelimits` list (Mon..Sun). */
const DAYS_PER_WEEK = 7;
/** Minutes in one local day — the end of a whole-day allowed window. */
const MINUTES_PER_DAY = 1440;
/** Seconds in one whole day — the maximal daily allowance. */
const SECONDS_PER_DAY = 86_400;
/**
 * Days in the longest month, for the rolling monthly cap. Using 31 (not 30/28)
 * guarantees the unrestricted monthly limit never *under*-allows in a long
 * month — the point is to stop limiting, so round up.
 */
const DAYS_PER_MONTH_MAX = 31;
/** Every ISO weekday, ascending — the keys of a full-week allowed grid. */
const ALL_ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

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
  /**
   * Date-specific overrides (#399), in precedence order. Optional — omit
   * (default `[]`) for the standing recurring push, which keeps exceptions out
   * of the weekly grid (ADR 0012 §3). The date-override enforcement push passes
   * the user's active exceptions so an override's day is folded into the
   * allowed-hours grid it pushes. Exceptions never change the seconds limits
   * (`perWeekdaySeconds` / weekly / monthly) — an additive time amount is a
   * `Grant`, not an exception — so only {@link ResolvedPolicyPush.weekly} differs.
   */
  readonly exceptions?: readonly ExceptionInput[];
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
 * The per-weekday daily overall limit comes from the resolver's weekday layer
 * (#141, ADR 0013), so the one "what applies on day D" computation stays the
 * single source. Each of the seven `--settimelimits` days is resolved
 * independently: a weekday with **no** daily overall budget is pushed as the
 * whole-day allowance (`SECONDS_PER_DAY` — the same "maximal allowance =
 * unrestricted" expression {@link unrestrictedPolicyPush} uses), and
 * `perWeekdaySeconds` is `null` (no daily limit pushed) only when **every**
 * weekday resolves to no limit. A uniform budget therefore still yields seven
 * identical values, exactly as before #141.
 */
export function resolvePolicyPush(input: PolicyPushResolveInput): ResolvedPolicyPush {
  const { tz, schedules, budgets, now } = input;

  const weekly = resolveWeeklyAllowedWindows({
    schedules,
    tz,
    reference: now,
    exceptions: input.exceptions ?? [],
  });

  // ALL_ISO_WEEKDAYS is Monday..Sunday — the same order as the seven-day
  // `--settimelimits` list, so this maps position-for-position.
  const perWeekday = ALL_ISO_WEEKDAYS.map((weekday) =>
    overallDailySecondsForWeekday(budgets, weekday),
  );
  const perWeekdaySeconds = perWeekday.every((seconds) => seconds === null)
    ? null
    : perWeekday.map((seconds) => seconds ?? SECONDS_PER_DAY);

  return {
    perWeekdaySeconds,
    weeklySeconds: rollingOverallSeconds(budgets, "weekly"),
    monthlySeconds: rollingOverallSeconds(budgets, "monthly"),
    weekly,
  };
}

/**
 * The fully-**unrestricted** push (#253): the maximal limits and an all-hours,
 * every-day allowed grid. The executor uses this to *unmanage* a supervised
 * account on a client when its user↔client link is removed — lifting whatever
 * `timekpra` limits/allowed-hours the dashboard last pushed back to "no
 * restriction" so a now-unlinked account isn't left enforced by stale policy.
 *
 * Timekpr-nExT always tracks every login user and the admin CLI has no "stop
 * tracking" verb, so "unrestricted" is expressed as the maximal allowance:
 * the whole day every day, with the rolling caps set to their per-period
 * maxima. This is deliberately **not** a session-kill or a zero limit — full
 * lockout is a Phase-8c concern, the opposite intent.
 *
 * Pure, like {@link resolvePolicyPush}: it returns the same {@link ResolvedPolicyPush}
 * shape so the executor drives it through the identical setter sequence (and so
 * the all-hours grid is non-empty, the full-lockout allowed-hours skip never
 * applies here).
 */
export function unrestrictedPolicyPush(): ResolvedPolicyPush {
  const allDay: readonly TimeWindow[] = [{ start: 0, end: MINUTES_PER_DAY }];
  const weekly: WeeklyAllowedWindows = new Map(
    ALL_ISO_WEEKDAYS.map((day) => [day, allDay] as const),
  );
  return {
    perWeekdaySeconds: Array.from({ length: DAYS_PER_WEEK }, () => SECONDS_PER_DAY),
    weeklySeconds: SECONDS_PER_DAY * DAYS_PER_WEEK,
    monthlySeconds: SECONDS_PER_DAY * DAYS_PER_MONTH_MAX,
    weekly,
  };
}
