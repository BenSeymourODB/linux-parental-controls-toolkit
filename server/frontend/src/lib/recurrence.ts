/**
 * Recurrence authoring helpers (#361 — the frontend last mile of #140).
 *
 * Pure conversions and validation shared by {@link ./components/RecurrenceFields.svelte}
 * and the schedule editors (`SchedulesView`, `GroupSchedulesView`), and reusable
 * by the future combined Policy view (#343). These mirror the server's
 * single-source recurrence rules in `server/src/policy/recurrence.ts` (the same
 * bounds the zod DTOs and the storage `CHECK`s enforce) so the editor can never
 * submit a combination the API will reject — while the server stays the
 * authority (its errors still surface through the view's error alert).
 *
 * Model recap:
 * - `recurrenceDays` — 7-bit ISO weekday mask, bit0=Mon … bit6=Sun, `[1,127]`;
 *   `null` (no bits set) = every day.
 * - `recurrenceStartMinute` / `recurrenceEndMinute` — minutes from local
 *   midnight on the half-open interval `[start,end)`, both-or-neither,
 *   `0 <= start < end <= 1440`.
 * - `effectiveFrom` / `effectiveTo` — ISO-8601 UTC instants; `null` = open-ended.
 *
 * License boundary: none — plain TypeScript, no backend coupling.
 */

/** Minutes in a full day — the exclusive end of the intra-day window space. */
export const MINUTES_PER_DAY = 1440;

/** Short ISO-weekday labels in mask-bit order (bit0=Mon … bit6=Sun). */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Full ISO-weekday names in mask-bit order, for accessible labels. */
export const WEEKDAY_FULL = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** The five recurrence + date-scope fields as authored on a schedule rule. */
export interface RecurrenceValue {
  recurrenceDays: number | null;
  recurrenceStartMinute: number | null;
  recurrenceEndMinute: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/** Whether weekday bit `index` (0=Mon … 6=Sun) is set in `mask`. */
export function dayChecked(mask: number | null, index: number): boolean {
  return mask !== null && (mask & (1 << index)) !== 0;
}

/**
 * Set/clear weekday bit `index` in `mask`, returning the new mask. A result of
 * no bits set collapses to `null` — the "every day" degenerate the DTO expects
 * (an empty selection is not a stored `0`).
 */
export function toggleDay(mask: number | null, index: number, checked: boolean): number | null {
  const base = mask ?? 0;
  const next = checked ? base | (1 << index) : base & ~(1 << index);
  return next === 0 ? null : next;
}

/**
 * Minutes-from-midnight → an `<input type="time">` value (`HH:MM`). `null`
 * renders as empty. The end-of-day sentinel `1440` (24:00, which a native time
 * input can't express) renders as `00:00` — see {@link timeInputToMinutes}.
 */
export function minutesToTimeInput(minutes: number | null): string {
  if (minutes === null) {
    return "";
  }
  const wrapped = minutes === MINUTES_PER_DAY ? 0 : minutes;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * An `<input type="time">` value (`HH:MM`) → minutes from midnight. Empty → `null`.
 *
 * Native time inputs top out at `23:59`, so "until end of day" (24:00 = 1440)
 * is expressed by entering `00:00` in the **end** field: when `isEnd` and the
 * parsed value is `0`, it maps to `1440`. This is unambiguous because a valid
 * window has `start < end` with `start >= 0`, so an end of `0` can never be
 * legitimate.
 */
export function timeInputToMinutes(value: string, isEnd: boolean): number | null {
  if (value === "") {
    return null;
  }
  const [hStr, mStr] = value.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isInteger(h) || !Number.isInteger(m)) {
    return null;
  }
  const minutes = h * 60 + m;
  return isEnd && minutes === 0 ? MINUTES_PER_DAY : minutes;
}

/**
 * An ISO-8601 instant → an `<input type="date">` value (`YYYY-MM-DD`) in the
 * viewer's local timezone. `null` renders as empty. Paired with
 * {@link dateInputToInstant} so a date authored, stored, and re-opened for edit
 * round-trips to the same calendar day in the admin's browser, matching the
 * summary's `toLocaleDateString()` rendering.
 */
export function instantToDateInput(iso: string | null): string {
  if (iso === null) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * An `<input type="date">` value (`YYYY-MM-DD`) → an ISO-8601 UTC instant at
 * local midnight of that day. Empty → `null`. Local midnight (not UTC) keeps
 * the round-trip with {@link instantToDateInput} stable in the admin's TZ.
 */
export function dateInputToInstant(value: string): string | null {
  if (value === "") {
    return null;
  }
  const [yStr, mStr, dStr] = value.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return null;
  }
  return new Date(y, m - 1, d).toISOString();
}

/**
 * Validate a recurrence combination against the DTO's cross-field invariants,
 * returning a human message or `null` when valid. Mirrors the `superRefine` in
 * `server/src/policy/recurrence.ts`:
 * - the two minute bounds are both set or both empty;
 * - when set, `start < end`;
 * - when both effective bounds are set, `effectiveFrom < effectiveTo`.
 *
 * Per-field bounds (mask `[1,127]`, minutes `[0,1440]`) are guaranteed by the
 * inputs themselves (checkboxes, native time pickers), so only the cross-field
 * rules need re-checking here.
 */
export function validateRecurrence(value: RecurrenceValue): string | null {
  const startSet = value.recurrenceStartMinute !== null;
  const endSet = value.recurrenceEndMinute !== null;

  if (startSet !== endSet) {
    return "Set both a start and end time, or leave both empty for all day.";
  }
  if (
    value.recurrenceStartMinute !== null &&
    value.recurrenceEndMinute !== null &&
    value.recurrenceStartMinute >= value.recurrenceEndMinute
  ) {
    return "The end time must be after the start time.";
  }
  if (
    value.effectiveFrom !== null &&
    value.effectiveTo !== null &&
    Date.parse(value.effectiveFrom) >= Date.parse(value.effectiveTo)
  ) {
    return "The end date must be after the start date.";
  }
  return null;
}
