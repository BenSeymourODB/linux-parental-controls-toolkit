/**
 * "When does overall access next change?" — the pure boundary walk behind the
 * `/app` per-child status screen's next-transition banner (#110, Phase 9).
 *
 * The effective-policy resolver ({@link import("./resolve.js").effectivePolicy})
 * already reduces a day's `overall`-scoped schedule rules to
 * {@link AllowedWindow}s — ascending, non-overlapping half-open `[start, end)`
 * ranges in **local minutes-from-midnight**, where an empty list means access
 * is denied all day and a single `{ 0, 1440 }` means unrestricted. This module
 * answers the follow-on question the status screen asks: *given it is now
 * `nowMinute` local, when does access next flip, and which way?*
 *
 * A schedule boundary ("bedtime at 21:00") is inherently a local wall-clock
 * concept, so the result is expressed as `{ kind, localDate, atMinuteOfDay }`
 * — the client renders the wall-clock time in the user's effective timezone,
 * faithful to ADR 0001's "store/compute in UTC, render local" split without
 * inventing a UTC instant for a value that is really a wall-clock time.
 *
 * Pure: no clock, no DB, no timezone math (the caller supplies the already-
 * resolved windows and the local minute). License boundary: none touched.
 */

/** A half-open allowed-access window in local minutes-from-midnight `[start, end)`. */
export interface AllowedWindow {
  readonly start: number;
  readonly end: number;
}

/** Which way overall access flips at a transition. */
export type TransitionKind = "access_ends" | "access_resumes";

/** The next overall-access transition, as a local wall-clock time. */
export interface NextTransition {
  /** `access_ends` = access pauses (a lock begins); `access_resumes` = it comes back. */
  readonly kind: TransitionKind;
  /** The local calendar date the transition falls on, `YYYY-MM-DD`. */
  readonly localDate: string;
  /** Minutes-from-midnight of the transition, `[0, 1440)`. */
  readonly atMinuteOfDay: number;
}

/** Minutes in a day; `1440` is midnight (the day boundary, never a surfaced flip). */
const MINUTES_PER_DAY = 1440;

/**
 * Is overall access allowed at `minute` given `windows`? A minute is allowed
 * iff it falls in some half-open window `[start, end)`. Exported so the status
 * route can report `allowedNow` from the same predicate this walk uses.
 */
export function isAccessAllowedAt(minute: number, windows: readonly AllowedWindow[]): boolean {
  return windows.some((w) => minute >= w.start && minute < w.end);
}

/**
 * Ascending, de-duplicated window-boundary minutes within `[lo, hi)`. These are
 * the only minutes at which {@link isAccessAllowedAt} can change value, so scanning them
 * finds every state flip without walking all 1440 minutes.
 */
function boundariesIn(windows: readonly AllowedWindow[], lo: number, hi: number): number[] {
  const set = new Set<number>();
  for (const w of windows) {
    if (w.start >= lo && w.start < hi) set.add(w.start);
    if (w.end >= lo && w.end < hi) set.add(w.end);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * The next overall-access transition at or after `nowMinute`, or `null` when
 * access never changes between now and the end of tomorrow (unrestricted or
 * denied straight through).
 *
 * Looks at **today** first — the earliest window boundary after `nowMinute`
 * (before midnight) at which access flips — then, if today holds steady to
 * midnight, at **tomorrow**, including the midnight crossing itself (so a
 * "denied all day today, resumes at 07:00 tomorrow" or a "unrestricted today,
 * bedtime at 21:00 tomorrow" both surface). Days beyond tomorrow are not
 * scanned: a status glance needs the *next* change, not a full calendar.
 *
 * @param today       today's overall allowed windows (local minutes).
 * @param nowMinute   the current local minute-of-day, `[0, 1440)`.
 * @param todayDate   today's local calendar date, `YYYY-MM-DD`.
 * @param tomorrow    tomorrow's overall allowed windows (local minutes).
 * @param tomorrowDate tomorrow's local calendar date, `YYYY-MM-DD`.
 */
export function nextOverallTransition(
  today: readonly AllowedWindow[],
  nowMinute: number,
  todayDate: string,
  tomorrow: readonly AllowedWindow[],
  tomorrowDate: string,
): NextTransition | null {
  const state = isAccessAllowedAt(nowMinute, today);

  // Today: the first boundary strictly after now (never midnight) that flips.
  for (const minute of boundariesIn(today, nowMinute + 1, MINUTES_PER_DAY)) {
    if (isAccessAllowedAt(minute, today) !== state) {
      return {
        kind: isAccessAllowedAt(minute, today) ? "access_resumes" : "access_ends",
        localDate: todayDate,
        atMinuteOfDay: minute,
      };
    }
  }

  // Tomorrow: midnight (0) is always a candidate — the state may flip on the
  // day crossing even when tomorrow has no intra-day boundaries (e.g. denied
  // all day) — followed by tomorrow's own boundaries.
  for (const minute of [0, ...boundariesIn(tomorrow, 1, MINUTES_PER_DAY)]) {
    if (isAccessAllowedAt(minute, tomorrow) !== state) {
      return {
        kind: isAccessAllowedAt(minute, tomorrow) ? "access_resumes" : "access_ends",
        localDate: tomorrowDate,
        atMinuteOfDay: minute,
      };
    }
  }

  return null;
}
