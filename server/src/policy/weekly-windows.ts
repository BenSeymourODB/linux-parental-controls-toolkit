/**
 * Weekly recurring allowed-access windows (#140, Phase 4).
 *
 * The transport layer (#140, `transport/timekpr/allowed-hours.ts`) can turn a
 * {@link WeeklyAllowedWindows} — per-ISO-weekday allowed-access windows — into
 * the `timekpra` allowed-days/allowed-hours push, but it deliberately leaves
 * *assembling* that weekly shape to its caller ("resolving `effectivePolicy`
 * once per weekday"). This module is that caller-side bridge: it runs the
 * effective-policy resolver ({@link ./resolve.js}, #143) over the seven local
 * days of a reference week and keys the resulting `allowedWindows` by ISO
 * weekday, ready to hand to {@link TimekprClient.setWeeklyAllowedHours} /
 * `buildWeeklyAllowedHoursCommands`.
 *
 * By default only the **recurring** layer is resolved: no budgets, no grants,
 * no date-specific overrides — the exception-free grid the standing `timekpra`
 * push consumes and the clean baseline a date-specific override reverts to. A
 * one-off calendar date is not a weekly-recurring pattern, so exceptions stay
 * out of that grid (ADR 0012 §3).
 *
 * The optional {@link WeeklyWindowsInput.exceptions} is the one exception to
 * that: it lets the date-override enforcement push (#399) resolve the seven days
 * of a *specific reference week* with the user's active overrides folded in,
 * producing the exception-inclusive grid to push when an override's window
 * arrives (and, once the override ages out, the same call with no active
 * exception yields the standing grid again — the revert). It is keyed by ISO
 * weekday like the recurring grid, so its caller reconciles it daily to keep
 * any weekday-slot aliasing (this Tuesday vs. next Tuesday) from outliving the
 * override — see `transport/exception-push`. Omit it (the default `[]`) for the
 * standing push and every existing caller: the result is byte-identical to the
 * recurring-only grid.
 *
 * License boundary: none touched — pure TypeScript over the policy model and a
 * type-only import of the transport's weekly shape.
 */
import { isoWeekday, localCalendarDate } from "./budget-window.js";
import { effectivePolicy, type ExceptionInput } from "./resolve.js";
import type { ScheduleRule } from "./schedule-precedence.js";
import type { TimeWindow, WeeklyAllowedWindows } from "../transport/timekpr/allowed-hours.js";
import type { IsoWeekday } from "../transport/timekpr/commands.js";

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
  /**
   * Date-specific overrides (#142/#399), in precedence order, to fold into each
   * day of the resolved week. Optional — omit (default `[]`) for the recurring
   * standing grid; the date-override push passes the user's active exceptions so
   * an override's day resolves to its overridden `allowedWindows`.
   */
  readonly exceptions?: readonly ExceptionInput[];
}

/** The seven ISO weekdays, Monday (1) … Sunday (7), in order. */
const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly IsoWeekday[];

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
 * user's effective timezone — the {@link WeeklyAllowedWindows} the `timekpra`
 * allowed-hours push consumes.
 *
 * Each value is the day's `allowedWindows` from the resolver (ascending,
 * non-overlapping local minute intervals; `[]` = denied all day,
 * `[{0,1440}]` = unrestricted).
 */
export function resolveWeeklyAllowedWindows(input: WeeklyWindowsInput): WeeklyAllowedWindows {
  const { schedules, tz, reference } = input;
  const exceptions = input.exceptions ?? [];
  const today = localCalendarDate(reference, tz);
  const referenceWeekday = isoWeekday(today.year, today.month, today.day);
  const monday = addCalendarDays(today, -(referenceWeekday - 1));

  const byWeekday = new Map<IsoWeekday, readonly TimeWindow[]>();
  for (const [offset, weekday] of ISO_WEEKDAYS.entries()) {
    const date = addCalendarDays(monday, offset);
    const effective = effectivePolicy({ date, tz, schedules, budgets: [], grants: [], exceptions });
    byWeekday.set(weekday, effective.allowedWindows);
  }
  return byWeekday;
}
