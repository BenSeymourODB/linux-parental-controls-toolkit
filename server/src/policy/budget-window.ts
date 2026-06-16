/**
 * Shared budget-window helper — the one place local time enters the
 * computation.
 *
 * Everything the server stores and computes is UTC (see
 * `docs/adr/0001-budget-timezone.md`). The single exception is deciding when
 * a daily/weekly/monthly budget *rolls over*: that boundary is a local
 * calendar instant in the user's effective timezone. Every rollup that needs
 * "which window is active and where are its edges?" — burndown views,
 * enforcement checks, grant-expiry math — goes through this module so the
 * rule is applied identically.
 *
 * The mid-window timezone-change rule is
 * `docs/adr/0003-mid-window-timezone-change.md`: the in-flight window is
 * pinned to the timezone in effect when it opened; a timezone change applies
 * only from the next window boundary. {@link effectiveWindow} implements that
 * on top of {@link windowContaining}.
 *
 * No new dependency: timezone arithmetic uses Node's built-in `Intl` (ADR
 * 0001 already commits to `Intl.supportedValuesOf` for validation), so this
 * stays a pure, dependency-free module.
 */
import type { BudgetWindow } from "./enums.js";

/**
 * A half-open budget window `[start, end)` as UTC instants, plus the IANA
 * timezone whose local calendar defined the boundaries.
 *
 * Half-open so adjacent windows tile the timeline with no gap or overlap:
 * one window's `end` is exactly the next window's `start`.
 */
export interface BudgetWindowBounds {
  /** Inclusive start, as a UTC instant. */
  readonly start: Date;
  /** Exclusive end, as a UTC instant. */
  readonly end: Date;
  /** IANA timezone whose local midnight defined `start` / `end`. */
  readonly tz: string;
}

/**
 * A recorded change of a user's effective timezone.
 *
 * Passed to {@link effectiveWindow} so the window open at {@link at} can be
 * pinned to {@link previousTz} per ADR 0003. A caller that has not recorded a
 * change passes nothing and gets the plain "current window in the effective
 * zone" result.
 */
export interface TimezoneChange {
  /** UTC instant at which the effective timezone changed. */
  readonly at: Date;
  /** The effective timezone in force *before* {@link at}. */
  readonly previousTz: string;
}

/** Local wall-clock calendar fields, as read in a specific timezone. */
interface ZonedParts {
  readonly year: number;
  /** 1-12 (calendar month, not 0-based). */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Is `tz` a timezone the runtime's `Intl` implementation accepts?
 *
 * Used to validate `PCT_DEFAULT_TZ` / `User.tz` at the boundary before they
 * reach the windowing math (ADR 0001 → "Validation").
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0) return false;
  try {
    // Constructing the formatter throws a RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Thrown when a timezone string is not a valid IANA zone. */
export class InvalidTimeZoneError extends Error {
  constructor(tz: string) {
    super(`Invalid IANA timezone: ${JSON.stringify(tz)}`);
    this.name = "InvalidTimeZoneError";
  }
}

/** Assert `tz` is a valid IANA zone, throwing {@link InvalidTimeZoneError} otherwise. */
export function assertTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) throw new InvalidTimeZoneError(tz);
}

/**
 * Resolve a user's effective timezone: their own `tz` if set, else the server
 * default (`User.tz ?? PCT_DEFAULT_TZ`, per ADR 0001).
 */
export function resolveEffectiveTz(userTz: string | null | undefined, defaultTz: string): string {
  return userTz ?? defaultTz;
}

/**
 * Offset of `tz` from UTC at `instant`, in milliseconds (e.g. `-5h` for
 * `America/New_York` in winter). DST-aware because it is evaluated at a
 * specific instant.
 */
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = readParts(dtf, instant);
  // Interpret the wall-clock fields as if they were UTC, then diff from the
  // real instant: (wall-as-UTC − instant) is exactly the zone's offset.
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wallAsUtc - instant.getTime();
}

/**
 * Read the local calendar/clock fields of `instant` in the formatter's zone.
 *
 * The formatter is always built (below) requesting all six numeric fields, so
 * each lookup is present; the `?? 0` only satisfies the strict index type and
 * is never reached in practice.
 */
function readParts(dtf: Intl.DateTimeFormat, instant: Date): ZonedParts {
  const out = new Map<string, number>();
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") out.set(part.type, Number(part.value));
  }
  return {
    year: out.get("year") ?? 0,
    month: out.get("month") ?? 0,
    day: out.get("day") ?? 0,
    hour: out.get("hour") ?? 0,
    minute: out.get("minute") ?? 0,
    second: out.get("second") ?? 0,
  };
}

/** The local calendar/clock fields of `instant` as seen in `tz`. */
function zonedParts(instant: Date, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return readParts(dtf, instant);
}

/**
 * The UTC instant of a given local wall-clock time in `tz`.
 *
 * Two-pass offset reconciliation: guess by treating the wall time as UTC,
 * correct by the offset at that guess, then re-check once so a wall time that
 * lands near a DST transition resolves to the offset actually in force.
 */
function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = tzOffsetMs(new Date(wallAsUtc), tz);
  let utc = wallAsUtc - firstOffset;
  const secondOffset = tzOffsetMs(new Date(utc), tz);
  if (secondOffset !== firstOffset) {
    utc = wallAsUtc - secondOffset;
  }
  return new Date(utc);
}

/** Local midnight (00:00:00) of the given local calendar date, as a UTC instant. */
function localMidnight(year: number, month: number, day: number, tz: string): Date {
  return wallTimeToUtc(year, month, day, 0, 0, 0, tz);
}

/**
 * Day-of-week (0 = Sunday … 6 = Saturday) of a local calendar date.
 *
 * Computed from the calendar fields alone — a `Date.UTC` of those fields is a
 * pure calendar lookup, independent of any timezone.
 */
function localWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Calendar date `n` days after `(year, month, day)`, as `{ year, month, day }`. */
function addDays(
  year: number,
  month: number,
  day: number,
  n: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The budget window of kind `window` that contains `instant`, with boundaries
 * at local midnight in `tz`.
 *
 * - `daily` — local midnight to the next local midnight.
 * - `weekly` — Monday 00:00 (ISO 8601 week start) to the following Monday.
 * - `monthly` — the 1st at 00:00 to the 1st of the next month.
 *
 * DST-correct: boundaries are computed as local-midnight wall times, so a
 * spring-forward day is 23h and a fall-back day is 25h.
 */
export function windowContaining(
  window: BudgetWindow,
  instant: Date,
  tz: string,
): BudgetWindowBounds {
  assertTimeZone(tz);
  const { year, month, day } = zonedParts(instant, tz);

  let startY = year;
  let startM = month;
  let startD = day;
  let end: { year: number; month: number; day: number };

  switch (window) {
    case "daily": {
      end = addDays(year, month, day, 1);
      break;
    }
    case "weekly": {
      // Back up to Monday (ISO 8601). getUTCDay: 0=Sun..6=Sat.
      const daysSinceMonday = (localWeekday(year, month, day) + 6) % 7;
      const monday = addDays(year, month, day, -daysSinceMonday);
      startY = monday.year;
      startM = monday.month;
      startD = monday.day;
      end = addDays(monday.year, monday.month, monday.day, 7);
      break;
    }
    case "monthly": {
      startD = 1;
      // First of the next month.
      end =
        startM === 12
          ? { year: startY + 1, month: 1, day: 1 }
          : { year: startY, month: startM + 1, day: 1 };
      break;
    }
  }

  return {
    start: localMidnight(startY, startM, startD, tz),
    end: localMidnight(end.year, end.month, end.day, tz),
    tz,
  };
}

/**
 * The budget window active at `now`, honouring the mid-window timezone-change
 * rule (ADR 0003).
 *
 * Without a `change`, this is simply {@link windowContaining} in
 * `effectiveTz` (where `effectiveTz` is the current effective zone). With a
 * `change`:
 *
 * - While `now` is inside the window that was open at `change.at` (computed
 *   in `change.previousTz`), that window stays pinned with its original
 *   `[start, end)` — a timezone change never shifts the in-flight boundary.
 * - From the pinned window's `end` onward, windows follow `effectiveTz`. The
 *   first such window's start is clamped to the pinned `end` so the two tile
 *   exactly (no gap, no overlap → no usage double-counted across the seam);
 *   this can make that one window a short "stub" until the next `effectiveTz`
 *   boundary, which is the deliberate, documented cost of the move.
 *
 * `change` is only consulted when it has already happened (`now >=
 * change.at`); a `now` before the change falls through to the plain
 * `effectiveTz` computation.
 */
export function effectiveWindow(
  window: BudgetWindow,
  now: Date,
  effectiveTz: string,
  change?: TimezoneChange,
): BudgetWindowBounds {
  if (change === undefined || now.getTime() < change.at.getTime()) {
    return windowContaining(window, now, effectiveTz);
  }

  const pinned = windowContaining(window, change.at, change.previousTz);
  if (now.getTime() < pinned.end.getTime()) {
    return pinned;
  }

  // Past the pinned window: compute the current window in the new zone, but
  // start no earlier than where the pinned window ended.
  const natural = windowContaining(window, now, effectiveTz);
  if (natural.start.getTime() < pinned.end.getTime()) {
    return { start: pinned.end, end: natural.end, tz: effectiveTz };
  }
  return natural;
}
