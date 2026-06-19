/**
 * Recurring schedule windows → `timekpra` allowed-hours / allowed-days mapping
 * (#140, Phase 4).
 *
 * The effective-policy resolver (#143, {@link import("../../policy/resolve.js")})
 * already projects a user's recurring `overall` schedule rules onto a day and
 * yields `allowedWindows` — half-open `[start, end)` intervals in local
 * minutes-from-midnight. This module is the **enforcement mapping**: it turns
 * those windows into the `timekpra` invocations the architecture's
 * "Enforcement responsibilities" table assigns to Timekpr-nExT ("Total session
 * time … configured by `timekpra` over SSH"):
 *
 * - `--setalloweddays USER 'd;…'` — the ISO weekdays the user may log in at
 *   all (a day with no allowed windows is excluded);
 * - `--setallowedhours USER (DAY|list) 'H;H[mm-mm];…'` — the hours, optionally
 *   sub-windowed to a single contiguous `[mm-mm]`, allowed on each day.
 *
 * Everything here is **pure** and depends only on the `timekpra` command
 * builders ({@link ./commands.js}) plus the structural `AllowedWindow` type —
 * no DB, no SSH, no policy *value* import. The policy→weekday resolution that
 * feeds it lives in {@link import("../../policy/weekly-windows.js")}; wiring
 * the result into the live CRUD→SSH push (replacing the Phase-2 stub) is the
 * broader push-orchestration step the stub's own docstring frames as its
 * swap-point.
 *
 * License boundary: none touched — pure TypeScript over our own command
 * builders; Timekpr-nExT (GPL) is still only ever the `timekpra` CLI run as a
 * subprocess over SSH (see `docs/licensing-analysis.md`).
 */
import type { AllowedWindow } from "../../policy/resolve.js";

import {
  buildSetAllowedDays,
  buildSetAllowedHours,
  type AllowedHour,
  type AllowedHoursDay,
  type IsoWeekday,
} from "./commands.js";
import type { TimekprClient } from "./client.js";
import { TimekprArgumentError } from "./errors.js";

/** Minutes in one clock hour. */
const MINUTES_PER_HOUR = 60;
/** Clock hours in a day (`timekpra` allowed-hours are keyed `0..23`). */
const HOURS_PER_DAY = 24;
/** Minutes in a full local day; the exclusive end of the window space. */
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;

/** The seven ISO weekdays, Monday (1) … Sunday (7), in order. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly IsoWeekday[];

/**
 * Validate that `windows` are the shape the resolver promises: each interval
 * integer-bounded within `[0, 1440]` with `start < end`, and the list ascending
 * and non-overlapping. The resolver already guarantees this; asserting it here
 * turns a malformed caller (or a future resolver regression) into a clear error
 * rather than a silently wrong `timekpra` invocation.
 */
function assertWindows(windows: readonly AllowedWindow[]): void {
  let previousEnd = 0;
  for (const window of windows) {
    const { start, end } = window;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > MINUTES_PER_DAY ||
      start >= end
    ) {
      throw new TimekprArgumentError(
        `timekpra: allowed window must satisfy 0 <= start < end <= ${MINUTES_PER_DAY}, got [${start}-${end}]`,
      );
    }
    if (start < previousEnd) {
      throw new TimekprArgumentError(
        `timekpra: allowed windows must be ascending and non-overlapping, got [${start}-${end}] after a window ending at ${previousEnd}`,
      );
    }
    previousEnd = end;
  }
}

/**
 * Map one day's allowed-access windows to a `timekpra` allowed-hours list.
 *
 * Each clock hour `0..23` that any window touches becomes one {@link AllowedHour}:
 * a fully-covered hour renders bare (`8`), a partially-covered hour carries its
 * single `[mm-mm]` sub-window (`8` with `startMinute`/`endMinute`). A day with no
 * windows maps to the empty list (the caller treats that as "denied").
 *
 * **Granularity limit (throws).** `timekpra` allows at most one contiguous
 * sub-window per hour. A schedule whose deny gap splits a single hour into two
 * allowed sub-windows (e.g. allow-all with a 08:10–08:20 deny) cannot be
 * expressed; widening would over-permit the deny and narrowing would deny
 * allowed time, so this throws {@link TimekprArgumentError} rather than enforce
 * something the admin did not ask for. Align that hour's windows to whole-hour
 * boundaries to resolve it.
 */
export function dayWindowsToAllowedHours(windows: readonly AllowedWindow[]): AllowedHour[] {
  assertWindows(windows);
  const hours: AllowedHour[] = [];
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const hourStart = hour * MINUTES_PER_HOUR;
    const hourEnd = hourStart + MINUTES_PER_HOUR;
    // The hour's covered span (in absolute minutes). Windows are ascending and
    // non-overlapping, so a window that starts past the running end leaves a
    // gap — a sub-hour deny `timekpra` cannot express as one `[mm-mm]`.
    let covered: { start: number; end: number } | undefined;
    let gapped = false;
    for (const window of windows) {
      const start = Math.max(window.start, hourStart);
      const end = Math.min(window.end, hourEnd);
      if (start >= end) continue;
      if (covered === undefined) covered = { start, end };
      else if (start > covered.end) gapped = true;
      else covered = { start: covered.start, end };
    }
    if (covered === undefined) continue;
    if (gapped) {
      throw new TimekprArgumentError(
        `timekpra: hour ${hour} has disjoint allowed sub-windows; allowed-hours can express at most one contiguous [mm-mm] window per hour. Align that hour's windows to whole-hour boundaries.`,
      );
    }
    const startMinute = covered.start - hourStart;
    const endMinute = covered.end - hourStart;
    if (startMinute === 0 && endMinute === MINUTES_PER_HOUR) {
      hours.push({ hour });
    } else {
      hours.push({ hour, startMinute, endMinute });
    }
  }
  return hours;
}

/** A weekday's resolved access: either an allowed-hours list, or fully denied. */
export type DayAllowance =
  | { readonly kind: "allowed"; readonly hours: readonly AllowedHour[] }
  | { readonly kind: "denied" };

/**
 * Classify one day's windows: `denied` when no hour is allowed, otherwise
 * `allowed` with the {@link AllowedHour} list.
 */
export function dayAllowance(windows: readonly AllowedWindow[]): DayAllowance {
  const hours = dayWindowsToAllowedHours(windows);
  if (hours.length === 0) return { kind: "denied" };
  return { kind: "allowed", hours };
}

/**
 * A group of weekdays that share an identical allowed-hours list — the unit one
 * `--setallowedhours` invocation covers (a single weekday or a weekday list).
 */
export interface AllowedHoursGroup {
  readonly days: readonly IsoWeekday[];
  readonly hours: readonly AllowedHour[];
}

/**
 * The full weekly `timekpra` plan: which weekdays permit any access, and the
 * allowed-hours grouped so identical days collapse to one invocation.
 */
export interface WeeklyAllowedHoursPlan {
  readonly allowedDays: readonly IsoWeekday[];
  readonly hourGroups: readonly AllowedHoursGroup[];
}

/** A stable key for an {@link AllowedHour} list so identical days can be grouped. */
function hoursSignature(hours: readonly AllowedHour[]): string {
  return hours
    .map((h) => `${h.hour}:${h.startMinute ?? ""}-${h.endMinute ?? ""}:${h.unaccounted ?? false}`)
    .join(",");
}

/**
 * Build the {@link WeeklyAllowedHoursPlan} from per-weekday windows. A weekday
 * absent from `perDay` (or mapped to `[]`) is treated as denied and excluded
 * from `allowedDays`.
 *
 * **Throws** when every weekday is denied: a whole-week lockout is the Phase-8c
 * lockout flow, not an allowed-hours schedule, and `--setalloweddays` cannot
 * take an empty weekday set.
 */
export function planWeeklyAllowedHours(
  perDay: ReadonlyMap<number, readonly AllowedWindow[]>,
): WeeklyAllowedHoursPlan {
  const allowedDays: IsoWeekday[] = [];
  const groups = new Map<string, { days: IsoWeekday[]; hours: readonly AllowedHour[] }>();
  for (const day of ISO_WEEKDAYS) {
    const allowance = dayAllowance(perDay.get(day) ?? []);
    if (allowance.kind === "denied") continue;
    allowedDays.push(day);
    const signature = hoursSignature(allowance.hours);
    const existing = groups.get(signature);
    if (existing) existing.days.push(day);
    else groups.set(signature, { days: [day], hours: allowance.hours });
  }
  if (allowedDays.length === 0) {
    throw new TimekprArgumentError(
      "timekpra: schedule denies access on every weekday; a whole-week lockout is the lockout flow (Phase 8c), not an allowed-hours mapping",
    );
  }
  // Deterministic order: groups by their earliest weekday (`days` is built in
  // ascending order, so `days[0]` is that group's earliest).
  const hourGroups = [...groups.values()]
    .sort((a, b) => (a.days[0] ?? 0) - (b.days[0] ?? 0))
    .map((group) => ({ days: group.days, hours: group.hours }));
  return { allowedDays, hourGroups };
}

/** The day position for a group: a single weekday, or the weekday list. */
function groupDay(group: AllowedHoursGroup): AllowedHoursDay {
  const [first, ...rest] = group.days;
  return rest.length === 0 && first !== undefined ? first : group.days;
}

/**
 * Render the weekly plan as the ordered list of `timekpra` argv vectors:
 * `--setalloweddays` first, then one `--setallowedhours` per weekday group.
 * Pure — the argv the SSH transport would run, without running anything.
 */
export function timekprWeekCommands(
  username: string,
  perDay: ReadonlyMap<number, readonly AllowedWindow[]>,
): string[][] {
  const plan = planWeeklyAllowedHours(perDay);
  const commands: string[][] = [buildSetAllowedDays(username, plan.allowedDays)];
  for (const group of plan.hourGroups) {
    commands.push(buildSetAllowedHours(username, groupDay(group), group.hours));
  }
  return commands;
}

/**
 * Push a user's weekly recurring windows to a client over the existing
 * {@link TimekprClient} seam: set the allowed weekdays, then the allowed hours
 * for each weekday group. Sequential so a later call never races the
 * `--setalloweddays` it depends on. The client's own `username`/target bind the
 * invocation; `perDay` is that user's resolved windows
 * (see {@link import("../../policy/weekly-windows.js").resolveWeeklyAllowedWindows}).
 */
export async function applyWeeklySchedule(
  client: TimekprClient,
  perDay: ReadonlyMap<number, readonly AllowedWindow[]>,
): Promise<void> {
  const plan = planWeeklyAllowedHours(perDay);
  await client.setAllowedDays(plan.allowedDays);
  for (const group of plan.hourGroups) {
    await client.setAllowedHours(groupDay(group), group.hours);
  }
}
