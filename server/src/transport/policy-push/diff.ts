/**
 * The save-and-push **preview diff** engine (#64, Phase 4).
 *
 * Given the {@link ResolvedPolicyPush} a user's policy resolves to *today*
 * (`before`) and the one a *proposed* edit would resolve to (`after`), this
 * produces a structured, human-readable change set — the "what will change on
 * the client before I push" the admin sees in the save-and-push bar
 * (`docs/architecture.md` → "Outbound (server → client) — policy push").
 *
 * It diffs at the **semantic** `ResolvedPolicyPush` level (daily/weekly/monthly
 * overall limits + the recurring allowed-hours grid), not raw `timekpra` argv:
 * that is the level the resolver (#143/#140) produces and the executor (#201)
 * consumes, and it is what reads naturally to a human ("overall daily 2h →
 * 2h 30m") rather than a `--settimelimits` vector.
 *
 * Everything here is **pure** — no I/O, no clock, no policy-layer imports beyond
 * the transport types. The preview route (`api/policy/preview-routes.ts`)
 * resolves `before`/`after` and hands them in.
 *
 * **Scope.** The SSH + `timekpra` session-limit transport that exists on `main`.
 * The Ansible-side filter diff (e2guardian / iptables) is Phase 6 (#90) and is
 * not modelled here.
 *
 * License boundary: none touched — plain TypeScript over the transport's own
 * resolved-push struct.
 */
import type { IsoWeekday } from "../timekpr/commands.js";
import type { TimeWindow } from "../timekpr/allowed-hours.js";
import type { ResolvedPolicyPush } from "./resolve.js";

/** Every ISO weekday, ascending — the iteration order for a full-week diff. */
const ALL_ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/** Short weekday labels (index by ISO weekday `1`=Mon … `7`=Sun). */
const WEEKDAY_LABELS: Readonly<Record<IsoWeekday, string>> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** Which resolved-push field a change concerns. */
export type PolicyPushChangeField =
  | "daily-overall"
  | "weekly-limit"
  | "monthly-limit"
  | "allowed-hours";

/** Whether a value appeared, disappeared, or changed between `before` and `after`. */
export type PolicyPushChangeKind = "added" | "removed" | "changed";

/** One human-readable difference between the `before` and `after` resolved push. */
export interface PolicyPushChange {
  /** The resolved-push field this row concerns. */
  readonly field: PolicyPushChangeField;
  /** Whether the value was added, removed, or changed. */
  readonly kind: PolicyPushChangeKind;
  /**
   * The ISO weekday (`1`=Mon … `7`=Sun) for a per-weekday row
   * (`allowed-hours`, or `daily-overall` when weekdays differ); `null` for a
   * whole-week row (the uniform daily limit, or the rolling weekly/monthly).
   */
  readonly weekday: IsoWeekday | null;
  /** The prior value, rendered for display; `null` when there was none. */
  readonly before: string | null;
  /** The proposed value, rendered for display; `null` when there is none. */
  readonly after: string | null;
  /** A one-line description, e.g. `Daily overall limit: 2h → 2h 30m`. */
  readonly summary: string;
}

/** The full preview diff between a current and a proposed resolved push. */
export interface PolicyPushDiff {
  /** `true` when {@link changes} is non-empty (the push would be a no-op if not). */
  readonly hasChanges: boolean;
  /** The ordered change set (daily, weekly, monthly, then allowed-hours). */
  readonly changes: readonly PolicyPushChange[];
}

/** Render a non-negative seconds duration as `2h 30m` / `45m` / `2h` / `0m`. */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/** Render a `null`-or-seconds limit: `null` → `no limit`, else {@link formatDuration}. */
function formatLimit(seconds: number | null): string {
  return seconds === null ? "no limit" : formatDuration(seconds);
}

/** Render a minute-of-day (`0`–`1440`) as `HH:MM` (`1440` → `24:00`). */
function formatMinuteOfDay(minute: number): string {
  const hour = Math.floor(minute / MINUTES_PER_HOUR);
  const min = minute % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Render a day's allowed windows as `08:00–12:00, 13:00–21:00`, or `none`. */
function formatWindows(windows: readonly TimeWindow[]): string {
  if (windows.length === 0) return "none";
  return windows.map((w) => `${formatMinuteOfDay(w.start)}–${formatMinuteOfDay(w.end)}`).join(", ");
}

/** Are two window lists structurally identical (same order, same bounds)? */
function windowsEqual(a: readonly TimeWindow[], b: readonly TimeWindow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) => {
    const other = b[i];
    return other !== undefined && w.start === other.start && w.end === other.end;
  });
}

/** The add/remove/change kind for a `before`/`after` pair of nullable values. */
function changeKind(before: unknown, after: unknown): PolicyPushChangeKind {
  if (before === null) return "added";
  if (after === null) return "removed";
  return "changed";
}

/** Build a single scalar-limit change row (daily-uniform, weekly, or monthly). */
function scalarLimitChange(
  field: PolicyPushChangeField,
  label: string,
  before: number | null,
  after: number | null,
): PolicyPushChange | null {
  if (before === after) return null;
  return {
    field,
    kind: changeKind(before, after),
    weekday: null,
    before: before === null ? null : formatLimit(before),
    after: after === null ? null : formatLimit(after),
    summary: `${label}: ${formatLimit(before)} → ${formatLimit(after)}`,
  };
}

/** Are all seven daily values equal (the only shape the resolver emits today)? */
function isUniform(perWeekday: readonly number[]): boolean {
  const first = perWeekday[0];
  return perWeekday.every((v) => v === first);
}

/** The daily-overall seconds for `weekday`, or `null` when there's no daily limit. */
function dailyFor(perWeekday: readonly number[] | null, weekday: IsoWeekday): number | null {
  if (perWeekday === null) return null;
  // perWeekdaySeconds is a 7-element Mon..Sun list; index by weekday-1.
  return perWeekday[weekday - 1] ?? null;
}

/**
 * Diff the daily overall limit. When both sides are weekday-uniform (today's
 * only shape) a single whole-week row is emitted; if a future weekday-varying
 * budget (#141) makes days differ, per-weekday rows are emitted for the days
 * that changed.
 */
function diffDailyOverall(
  before: readonly number[] | null,
  after: readonly number[] | null,
): PolicyPushChange[] {
  if (before === null && after === null) return [];

  const bothUniform =
    (before === null || isUniform(before)) && (after === null || isUniform(after));
  if (bothUniform) {
    const change = scalarLimitChange(
      "daily-overall",
      "Daily overall limit",
      dailyFor(before, 1),
      dailyFor(after, 1),
    );
    return change === null ? [] : [change];
  }

  const changes: PolicyPushChange[] = [];
  for (const weekday of ALL_ISO_WEEKDAYS) {
    const b = dailyFor(before, weekday);
    const a = dailyFor(after, weekday);
    if (b === a) continue;
    changes.push({
      field: "daily-overall",
      kind: changeKind(b, a),
      weekday,
      before: b === null ? null : formatLimit(b),
      after: a === null ? null : formatLimit(a),
      summary: `Daily overall limit (${WEEKDAY_LABELS[weekday]}): ${formatLimit(b)} → ${formatLimit(a)}`,
    });
  }
  return changes;
}

/** Diff the recurring allowed-hours grid, one row per weekday whose windows differ. */
function diffAllowedHours(
  before: ResolvedPolicyPush["weekly"],
  after: ResolvedPolicyPush["weekly"],
): PolicyPushChange[] {
  const changes: PolicyPushChange[] = [];
  for (const weekday of ALL_ISO_WEEKDAYS) {
    const b = before.get(weekday) ?? [];
    const a = after.get(weekday) ?? [];
    if (windowsEqual(a, b)) continue;
    // "added" when the day was fully denied before and now has windows;
    // "removed" when it had windows and is now fully denied; else "changed".
    const kind: PolicyPushChangeKind =
      b.length === 0 ? "added" : a.length === 0 ? "removed" : "changed";
    changes.push({
      field: "allowed-hours",
      kind,
      weekday,
      before: formatWindows(b),
      after: formatWindows(a),
      summary: `Allowed hours (${WEEKDAY_LABELS[weekday]}): ${formatWindows(b)} → ${formatWindows(a)}`,
    });
  }
  return changes;
}

/**
 * Compute the human-readable preview diff between a user's current resolved
 * push (`before`) and the one a proposed edit resolves to (`after`).
 *
 * Rows are ordered daily-overall → weekly → monthly → allowed-hours (the order
 * the admin reads them in the save bar). An empty change set means the proposed
 * edit would push nothing new ({@link PolicyPushDiff.hasChanges} `false`).
 */
export function diffResolvedPush(
  before: ResolvedPolicyPush,
  after: ResolvedPolicyPush,
): PolicyPushDiff {
  const changes: PolicyPushChange[] = [
    ...diffDailyOverall(before.perWeekdaySeconds, after.perWeekdaySeconds),
  ];

  const weekly = scalarLimitChange(
    "weekly-limit",
    "Weekly overall limit",
    before.weeklySeconds,
    after.weeklySeconds,
  );
  if (weekly !== null) changes.push(weekly);

  const monthly = scalarLimitChange(
    "monthly-limit",
    "Monthly overall limit",
    before.monthlySeconds,
    after.monthlySeconds,
  );
  if (monthly !== null) changes.push(monthly);

  changes.push(...diffAllowedHours(before.weekly, after.weekly));

  return { hasChanges: changes.length > 0, changes };
}
