/**
 * Pure argv builders for the Timekpr-nExT **`timekpra` admin CLI**.
 *
 * Each `build*` function returns an argv **vector** (`readonly string[]`) — the
 * exact shape the SSH facade shell-quotes into one command string
 * ({@link ../ssh/facade.ts}), never a pre-joined string — so a value can never
 * be reinterpreted by the remote shell. The functions are pure and total: they
 * either return a valid vector or throw {@link TimekprArgumentError}
 * synchronously; they perform no I/O. {@link TimekprClient} composes them with
 * the transport.
 *
 * CLI grammar (verified against the upstream `timekpra` docs), using ISO-8601
 * conventions throughout — weekdays `1` (Mon) … `7` (Sun), hours `0`–`23`,
 * durations in **seconds**, list items separated by `;`:
 *
 * - `--setalloweddays USER 'd;d;…'`
 * - `--setallowedhours USER (DAY|ALL) 'H;H[mm-mm];!H;…'`
 * - `--settimelimits USER 's;s;…'`  (per allowed weekday)
 * - `--settimelimitweek USER s` / `--settimelimitmonth USER s`
 * - `--setplaytimeenabled USER (true|false)`
 * - `--setplaytimelimitoverride USER (true|false)`
 * - `--setplaytimeunaccountedintervalsenabled USER (true|false)`
 * - `--setplaytimealloweddays USER 'd;d;…'`
 * - `--setplaytimelimits USER 's;s;…'`
 * - `--setplaytimeactivities USER 'mask[desc];mask;…'`
 * - `--userinfo USER`
 *
 * The policy→`timekpra` mapping (which Budget/Schedule becomes which command)
 * is **not** here — it belongs to the resolver (#143) and the recurring-window
 * push (#140), which feed these builders transport-level inputs once the Phase-2
 * schema reservation (#146) lands. Keeping that mapping out keeps this layer
 * decoupled from the policy schema currently being reshaped.
 *
 * License boundary: none touched — plain TypeScript building an argv vector for
 * a subprocess. No GPL code is linked in-process (`CLAUDE.md` → "License
 * boundaries"; `docs/licensing-analysis.md`).
 */
import { TimekprArgumentError } from "./errors.js";

/** An ISO-8601 weekday number: `1` = Monday … `7` = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Sentinel for "every day" in {@link buildSetAllowedHours}'s day position. */
export const ALL_DAYS = "ALL";

/**
 * Which day(s) an allowed-hours rule applies to:
 * - a single ISO weekday (`3`),
 * - a non-empty list of ISO weekdays (`[1, 2, 3, 4, 5]`), which `timekpra`
 *   accepts as a `;`-joined set in the day position, or
 * - the {@link ALL_DAYS} sentinel for every day.
 */
export type AllowedHoursDay = IsoWeekday | readonly IsoWeekday[] | typeof ALL_DAYS;

/**
 * One entry in a `timekpra` allowed-hours list.
 *
 * Renders as `[!]H[(start)-(end)]`:
 * - `hour` — the clock hour, `0`–`23`.
 * - `startMinute`/`endMinute` — optional minute window *within* the hour,
 *   `0 ≤ start < end ≤ 60`. Both must be given together or neither (the
 *   bracket needs both bounds); omit both for the whole hour.
 * - `unaccounted` — when true, prefixes `!`: the hour is *allowed but free*
 *   (does not count against the time limit).
 */
export interface AllowedHour {
  readonly hour: number;
  readonly startMinute?: number;
  readonly endMinute?: number;
  readonly unaccounted?: boolean;
}

/**
 * One PlayTime activity matcher.
 *
 * Renders as `mask` or `mask[description]`:
 * - `mask` — the process-name mask Timekpr matches (e.g. `"minetest"`).
 * - `description` — optional human label shown in the client.
 *
 * Neither field may contain the grammar's separators (`;`) or brackets
 * (`[` / `]`); a value that does throws {@link TimekprArgumentError} rather
 * than producing an ambiguous list.
 */
export interface PlayTimeActivity {
  readonly mask: string;
  readonly description?: string;
}

const LIST_SEPARATOR = ";";

/**
 * A Linux account name is safe for a `timekpra` positional argument. Usernames
 * cannot contain whitespace, `;`, `[`, `]`, or control characters; rejecting
 * those here turns a malformed caller value into a clear error rather than a
 * silently wrong invocation. (The SSH facade additionally shell-quotes every
 * argument, so this is about argument *correctness*, not shell safety.)
 */
export function assertUsername(username: string): void {
  if (username.length === 0) {
    throw new TimekprArgumentError("timekpra: username must not be empty");
  }
  // eslint-disable-next-line no-control-regex -- intentionally rejecting controls
  if (/[\s;[\]\x00-\x1f]/.test(username)) {
    throw new TimekprArgumentError(
      `timekpra: invalid username ${JSON.stringify(username)} (whitespace, ';', '[', ']', or control characters are not allowed)`,
    );
  }
}

/** Assert `value` is a non-negative safe integer (a duration in seconds). */
function assertSeconds(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TimekprArgumentError(
      `timekpra: ${label} must be a non-negative integer number of seconds, got ${value}`,
    );
  }
}

/** Format a non-empty list of per-day second values as `'s;s;…'`. */
function formatSecondsList(perDaySeconds: readonly number[], label: string): string {
  if (perDaySeconds.length === 0) {
    throw new TimekprArgumentError(`timekpra: ${label} must list at least one day`);
  }
  for (const seconds of perDaySeconds) assertSeconds(seconds, label);
  return perDaySeconds.join(LIST_SEPARATOR);
}

/** Format a non-empty list of ISO weekdays as `'d;d;…'`. */
function formatDays(days: readonly IsoWeekday[], label: string): string {
  if (days.length === 0) {
    throw new TimekprArgumentError(`timekpra: ${label} must list at least one weekday`);
  }
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new TimekprArgumentError(
        `timekpra: ${label} weekday must be an ISO weekday 1..7 (Mon..Sun), got ${day}`,
      );
    }
  }
  return days.join(LIST_SEPARATOR);
}

/** Render the day position of an allowed-hours command: a weekday, list, or `ALL`. */
function formatAllowedHoursDay(day: AllowedHoursDay): string {
  if (day === ALL_DAYS) return ALL_DAYS;
  // `typeof === "number"` narrows the single-weekday case cleanly out of the
  // union (unlike `Array.isArray`, which does not narrow a `readonly` array).
  if (typeof day === "number") {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new TimekprArgumentError(
        `timekpra: allowed-hours day must be an ISO weekday 1..7, a weekday list, or "ALL", got ${day}`,
      );
    }
    return String(day);
  }
  return formatDays(day, "allowed-hours days");
}

/** Render one {@link AllowedHour} as `[!]H[(start)-(end)]`. */
function formatAllowedHour(entry: AllowedHour): string {
  const { hour, startMinute, endMinute, unaccounted } = entry;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new TimekprArgumentError(`timekpra: allowed hour must be 0..23, got ${hour}`);
  }
  const hasStart = startMinute !== undefined;
  const hasEnd = endMinute !== undefined;
  if (hasStart !== hasEnd) {
    throw new TimekprArgumentError(
      `timekpra: allowed hour ${hour} minute window needs both startMinute and endMinute, or neither`,
    );
  }
  let bracket = "";
  if (hasStart && hasEnd) {
    const start = startMinute;
    const end = endMinute;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > 60 ||
      start >= end
    ) {
      throw new TimekprArgumentError(
        `timekpra: allowed hour ${hour} minute window must satisfy 0 <= start < end <= 60, got [${start}-${end}]`,
      );
    }
    bracket = `[${pad2(start)}-${pad2(end)}]`;
  }
  return `${unaccounted === true ? "!" : ""}${hour}${bracket}`;
}

/** Format a non-empty allowed-hours list as `'H;H[mm-mm];!H;…'`. */
function formatAllowedHours(hours: readonly AllowedHour[]): string {
  if (hours.length === 0) {
    throw new TimekprArgumentError("timekpra: allowed hours must list at least one hour");
  }
  return hours.map(formatAllowedHour).join(LIST_SEPARATOR);
}

/** Format a non-empty PlayTime activity list as `'mask[desc];mask;…'`. */
function formatActivities(activities: readonly PlayTimeActivity[]): string {
  if (activities.length === 0) {
    throw new TimekprArgumentError("timekpra: PlayTime activities must list at least one entry");
  }
  return activities
    .map(({ mask, description }) => {
      if (mask.length === 0 || /[;[\]]/.test(mask)) {
        throw new TimekprArgumentError(
          `timekpra: PlayTime activity mask ${JSON.stringify(mask)} must be non-empty and contain no ';', '[' or ']'`,
        );
      }
      // Treat an absent or empty description identically: emit the bare mask
      // rather than an empty `mask[]` bracket.
      if (description === undefined || description === "") return mask;
      if (/[;[\]]/.test(description)) {
        throw new TimekprArgumentError(
          `timekpra: PlayTime activity description ${JSON.stringify(description)} must contain no ';', '[' or ']'`,
        );
      }
      return `${mask}[${description}]`;
    })
    .join(LIST_SEPARATOR);
}

/** Render a boolean toggle as the `timekpra` literals `true` / `false`. */
function formatBool(value: boolean): string {
  return value ? "true" : "false";
}

/** Zero-pad a minute value to two digits (`5` → `"05"`). */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// --- argv builders ---------------------------------------------------------

/** `--setalloweddays USER 'd;d;…'` — the weekdays the user may log in. */
export function buildSetAllowedDays(username: string, days: readonly IsoWeekday[]): string[] {
  assertUsername(username);
  return ["--setalloweddays", username, formatDays(days, "allowed days")];
}

/** `--setallowedhours USER (DAY|ALL) 'H;…'` — the hours allowed on a day. */
export function buildSetAllowedHours(
  username: string,
  day: AllowedHoursDay,
  hours: readonly AllowedHour[],
): string[] {
  assertUsername(username);
  return ["--setallowedhours", username, formatAllowedHoursDay(day), formatAllowedHours(hours)];
}

/** `--settimelimits USER 's;s;…'` — daily limit seconds, per allowed weekday. */
export function buildSetTimeLimits(username: string, perDaySeconds: readonly number[]): string[] {
  assertUsername(username);
  return ["--settimelimits", username, formatSecondsList(perDaySeconds, "daily time limits")];
}

/** `--settimelimitweek USER s` — rolling weekly limit in seconds. */
export function buildSetTimeLimitWeek(username: string, seconds: number): string[] {
  assertUsername(username);
  assertSeconds(seconds, "weekly time limit");
  return ["--settimelimitweek", username, String(seconds)];
}

/** `--settimelimitmonth USER s` — rolling monthly limit in seconds. */
export function buildSetTimeLimitMonth(username: string, seconds: number): string[] {
  assertUsername(username);
  assertSeconds(seconds, "monthly time limit");
  return ["--settimelimitmonth", username, String(seconds)];
}

/** `--setplaytimeenabled USER (true|false)` — master PlayTime switch. */
export function buildSetPlayTimeEnabled(username: string, enabled: boolean): string[] {
  assertUsername(username);
  return ["--setplaytimeenabled", username, formatBool(enabled)];
}

/**
 * `--setplaytimelimitoverride USER (true|false)` — when true, PlayTime limits
 * apply *instead of* (override) the overall session limit rather than within it.
 */
export function buildSetPlayTimeLimitOverride(username: string, enabled: boolean): string[] {
  assertUsername(username);
  return ["--setplaytimelimitoverride", username, formatBool(enabled)];
}

/**
 * `--setplaytimeunaccountedintervalsenabled USER (true|false)` — when true,
 * PlayTime is counted even during otherwise-unaccounted (free) hours.
 */
export function buildSetPlayTimeUnaccountedIntervalsEnabled(
  username: string,
  enabled: boolean,
): string[] {
  assertUsername(username);
  return ["--setplaytimeunaccountedintervalsenabled", username, formatBool(enabled)];
}

/** `--setplaytimealloweddays USER 'd;d;…'` — weekdays PlayTime is allowed. */
export function buildSetPlayTimeAllowedDays(
  username: string,
  days: readonly IsoWeekday[],
): string[] {
  assertUsername(username);
  return ["--setplaytimealloweddays", username, formatDays(days, "PlayTime allowed days")];
}

/** `--setplaytimelimits USER 's;s;…'` — PlayTime limit seconds, per weekday. */
export function buildSetPlayTimeLimits(
  username: string,
  perDaySeconds: readonly number[],
): string[] {
  assertUsername(username);
  return [
    "--setplaytimelimits",
    username,
    formatSecondsList(perDaySeconds, "PlayTime daily limits"),
  ];
}

/** `--setplaytimeactivities USER 'mask[desc];…'` — the matched app set. */
export function buildSetPlayTimeActivities(
  username: string,
  activities: readonly PlayTimeActivity[],
): string[] {
  assertUsername(username);
  return ["--setplaytimeactivities", username, formatActivities(activities)];
}

/** `--userinfo USER` — print the user's current Timekpr configuration. */
export function buildUserInfo(username: string): string[] {
  assertUsername(username);
  return ["--userinfo", username];
}
