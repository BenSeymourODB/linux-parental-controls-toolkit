/**
 * Recurring-window → `timekpra` allowed-hours translation (#140, Phase 4).
 *
 * The effective-policy resolver (#143, {@link ../../policy/resolve.ts}) answers
 * "what overall-access windows apply for user *U* on local day *D*?" as an
 * ascending, non-overlapping list of half-open `[start, end)` intervals in
 * **local minutes from midnight**. This module is the enforcement-mapping half
 * the resolver and the `timekpra` builders (#83, {@link ./commands.ts}) both
 * deferred to #140: it turns those windows into the `timekpra` allowed-hours /
 * allowed-days argv the SSH transport pushes to the client.
 *
 * It is the place ADR 0005 §1 points at — "the purpose-built struct maps 1:1
 * onto … the Timekpr allowed-hours target … #140 confirms the exact
 * correspondence against the `timekpra` CLI when it builds the translation."
 * That correspondence is per-weekday: an overnight span is two per-day rules on
 * both sides, so each `[start, end)` stays within one local day and maps to one
 * day's allowed-hours list (ADR 0005 §1, "so no information is lost").
 *
 * Everything here is **pure** — it produces argv vectors, performs no I/O, and
 * throws {@link TimekprArgumentError} for any window set the `timekpra` grammar
 * cannot represent. {@link TimekprClient.setWeeklyAllowedHours} runs the result
 * over the SSH facade.
 *
 * License boundary: none touched — plain TypeScript building an argv vector for
 * the existing `timekpra` subprocess. No GPL code is linked in-process
 * (`CLAUDE.md` → "License boundaries"; `docs/licensing-analysis.md`).
 */
import {
  ALL_DAYS,
  buildSetAllowedDays,
  buildSetAllowedHours,
  type AllowedHour,
  type IsoWeekday,
} from "./commands.js";
import { TimekprArgumentError } from "./errors.js";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
/** Every ISO weekday, ascending — the iteration order for a full-week push. */
const ALL_ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * A half-open allowed-access interval in **local minutes from midnight**
 * `[start, end)`. Structurally identical to the resolver's `AllowedWindow`
 * (`policy/resolve.ts`), so `effectivePolicy(...).allowedWindows` feeds these
 * functions directly; declared here so this transport module need not import
 * the policy layer.
 */
export interface TimeWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * The allowed-access windows for a user's week, keyed by ISO weekday
 * (`1` = Monday … `7` = Sunday). A weekday that is absent — or maps to an empty
 * list — is **fully denied** that day. This is the shape a caller assembles by
 * resolving {@link effectivePolicy} once per weekday.
 */
export type WeeklyAllowedWindows = ReadonlyMap<IsoWeekday, readonly TimeWindow[]>;

/**
 * Validate that `windows` are well-formed and in the contract the resolver
 * guarantees: each interval integer-valued with `0 ≤ start < end ≤ 1440`, and
 * the list ascending and non-overlapping. Defensive — the resolver already
 * emits this shape — so a hand-built or future caller fails loudly rather than
 * producing a silently wrong push.
 */
function assertWindows(windows: readonly TimeWindow[]): void {
  let prevEnd = 0;
  for (const { start, end } of windows) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new TimekprArgumentError(
        `timekpra: allowed window bounds must be integer minutes, got [${start}-${end}]`,
      );
    }
    if (start < 0 || end > MINUTES_PER_DAY || start >= end) {
      throw new TimekprArgumentError(
        `timekpra: allowed window must satisfy 0 <= start < end <= ${MINUTES_PER_DAY}, got [${start}-${end}]`,
      );
    }
    if (start < prevEnd) {
      throw new TimekprArgumentError(
        `timekpra: allowed windows must be ascending and non-overlapping, got [${start}-${end}] after an interval ending at ${prevEnd}`,
      );
    }
    prevEnd = end;
  }
}

/**
 * Map one local day's allowed windows to a `timekpra` allowed-hours list.
 *
 * Walks each window across the clock hours it touches: a fully-covered hour
 * becomes a bare `H`, a partly-covered one becomes `H[mm-mm]` for the sub-hour
 * interval. A fully-allowed day (`[{ start: 0, end: 1440 }]`) yields all 24
 * bare hours; an empty list yields `[]` (the day is fully denied — the weekly
 * builder expresses that by omitting the day from `--setalloweddays`, since
 * `--setallowedhours` cannot take an empty list).
 *
 * **Sub-hour fragmentation throws.** `timekpra` allows at most one minute
 * bracket per clock hour, so a single hour holding two disjoint allowed
 * intervals (an allow/deny/allow split finer than the hour) is not
 * representable. Rather than over-permit (merge the gap) or under-permit (drop
 * the hour) — either of which would silently misenforce — this throws
 * {@link TimekprArgumentError} so the boundary surfaces the limitation.
 */
export function allowedWindowsToAllowedHours(windows: readonly TimeWindow[]): AllowedHour[] {
  assertWindows(windows);

  const byHour = new Map<number, AllowedHour>();
  for (const { start, end } of windows) {
    const firstHour = Math.floor(start / MINUTES_PER_HOUR);
    // `end` is exclusive, so the last hour touched is the hour of `end - 1`.
    const lastHour = Math.floor((end - 1) / MINUTES_PER_HOUR);
    for (let hour = firstHour; hour <= lastHour; hour++) {
      if (byHour.has(hour)) {
        throw new TimekprArgumentError(
          `timekpra: cannot map allowed windows to allowed-hours: clock hour ${hour} contains more than one disjoint allowed interval, which the per-hour 'H[mm-mm]' grammar cannot represent — split the schedule so each hour holds a single interval, or align rule boundaries to the hour`,
        );
      }
      const hourStart = hour * MINUTES_PER_HOUR;
      const startMinute = Math.max(start, hourStart) - hourStart;
      const endMinute = Math.min(end, hourStart + MINUTES_PER_HOUR) - hourStart;
      const coversWholeHour = startMinute === 0 && endMinute === MINUTES_PER_HOUR;
      byHour.set(hour, coversWholeHour ? { hour } : { hour, startMinute, endMinute });
    }
  }

  return [...byHour.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry);
}

/** Are two allowed-hours lists identical? (Deterministic order ⇒ structural compare.) */
function sameAllowedHours(a: readonly AllowedHour[], b: readonly AllowedHour[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      entry.hour === other.hour &&
      entry.startMinute === other.startMinute &&
      entry.endMinute === other.endMinute &&
      entry.unaccounted === other.unaccounted
    );
  });
}

/**
 * Translate a user's whole week of allowed windows into the ordered `timekpra`
 * argv vectors that push it: a single `--setalloweddays` naming the permitted
 * weekdays, then the `--setallowedhours` commands.
 *
 * Each vector is **builder-level** — the `--flag …` argv the pure builders
 * return, without the `sudo timekpra` prefix; {@link TimekprClient} prepends
 * that. Allowed-hours commands are emitted **per allowed weekday**, except when
 * all seven days are allowed and share identical hours, where they collapse to
 * one `ALL` command (the common "same hours every day" case, e.g. "deny after
 * 21:00 daily"). A day with no window is omitted from `--setalloweddays`, which
 * is how full-day denial is expressed.
 *
 * Throws {@link TimekprArgumentError} if **no** day is allowed: a full lockout
 * is a daily-limit / session-kill concern (Phase 8c), not an allowed-hours one,
 * and `--setalloweddays` cannot take an empty set.
 */
export function buildWeeklyAllowedHoursCommands(
  username: string,
  weekly: WeeklyAllowedWindows,
): string[][] {
  const allowed: { readonly day: IsoWeekday; readonly hours: AllowedHour[] }[] = [];
  for (const weekday of ALL_ISO_WEEKDAYS) {
    const windows = weekly.get(weekday) ?? [];
    if (windows.length === 0) continue;
    allowed.push({ day: weekday, hours: allowedWindowsToAllowedHours(windows) });
  }

  const first = allowed[0];
  if (first === undefined) {
    throw new TimekprArgumentError(
      "timekpra: no allowed weekdays — a fully-denied week is enforced via a zero daily limit or session-kill (Phase 8c), not allowed-hours",
    );
  }

  const commands: string[][] = [
    buildSetAllowedDays(
      username,
      allowed.map((a) => a.day),
    ),
  ];

  // Collapse to one `ALL` command only when every weekday is allowed with the
  // same hours; otherwise a per-day command keeps denied days untouched.
  const everyDayAllowed = allowed.length === ALL_ISO_WEEKDAYS.length;
  const allIdentical =
    everyDayAllowed && allowed.every((a) => sameAllowedHours(a.hours, first.hours));

  if (allIdentical) {
    commands.push(buildSetAllowedHours(username, ALL_DAYS, first.hours));
  } else {
    for (const a of allowed) {
      commands.push(buildSetAllowedHours(username, a.day, a.hours));
    }
  }

  return commands;
}
