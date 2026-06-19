/**
 * Weekly recurring allowed-access windows (#140, Phase 4).
 *
 * `timekpra`'s allowed-hours is a **static weekly schedule** — seven days, each
 * with its own allowed hours. To feed it, this resolves a user's recurring
 * `overall` schedule rules into the allowed-access windows for each ISO weekday,
 * by running the effective-policy resolver ({@link ./resolve.js}, #143) over the
 * seven local days of a reference week and keying the result by weekday.
 *
 * Only the **recurring** layer is resolved: no budgets, no grants, no
 * date-specific overrides. Those are date-bound and adjust the daily *limit*,
 * not the static weekly allowed-hours grid; date-specific overrides (#142) are a
 * later, separately-composed layer. The transport-side mapping of these windows
 * to `timekpra` invocations lives in
 * {@link import("../transport/timekpr/allowed-hours.js")}.
 *
 * License boundary: none touched — pure TypeScript over the policy model.
 */
import { isoWeekday, localCalendarDate } from "./budget-window.js";
import { effectivePolicy, type AllowedWindow } from "./resolve.js";
import type { ScheduleRule } from "./schedule-precedence.js";

/** A local calendar date with a 1-12 month, as the resolver consumes. */
interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Inputs to {@link resolveWeeklyAllowedWindows}. */
export interface WeeklyWindowsInput {
  /** The user's `overall` (and other) schedule rules, already loaded. */
  readonly schedules: readonly ScheduleRule[];
  /** The user's effective timezone (`User.tz ?? PCT_DEFAULT_TZ`). */
  readonly tz: string;
  /** Any instant within the target week; its seven local days are resolved. */
  readonly reference: Date;
}

/**
 * Add `days` calendar days to a 1-12-month date, via UTC date arithmetic (no
 * timezone involved — this is pure calendar maths, the TZ only matters when the
 * resolver turns a date into instants).
 */
function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Resolve a user's recurring allowed-access windows for each ISO weekday
 * (`1` = Monday … `7` = Sunday) of the week containing `reference`, in the
 * user's effective timezone.
 *
 * Returns a map keyed by ISO weekday; each value is the day's
 * `allowedWindows` from the resolver (ascending, non-overlapping local
 * minute intervals; `[]` = denied all day, `[{0,1440}]` = unrestricted).
 */
export function resolveWeeklyAllowedWindows(
  input: WeeklyWindowsInput,
): Map<number, AllowedWindow[]> {
  const { schedules, tz, reference } = input;
  const today = localCalendarDate(reference, tz);
  const referenceWeekday = isoWeekday(today.year, today.month, today.day);
  const monday = addCalendarDays(today, -(referenceWeekday - 1));

  const byWeekday = new Map<number, AllowedWindow[]>();
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addCalendarDays(monday, offset);
    const weekday = isoWeekday(date.year, date.month, date.day);
    const effective = effectivePolicy({ date, tz, schedules, budgets: [], grants: [] });
    byWeekday.set(weekday, effective.allowedWindows);
  }
  return byWeekday;
}
