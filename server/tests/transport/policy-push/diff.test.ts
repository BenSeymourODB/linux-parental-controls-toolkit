/**
 * Unit tests for the save-and-push preview diff engine (#64): the pure
 * `before`/`after` `ResolvedPolicyPush` → human-readable change set.
 */
import { describe, expect, it } from "vitest";

import type { IsoWeekday } from "../../../src/transport/timekpr/commands.js";
import type {
  TimeWindow,
  WeeklyAllowedWindows,
} from "../../../src/transport/timekpr/allowed-hours.js";
import { diffResolvedPush, formatDuration } from "../../../src/transport/policy-push/diff.js";
import type { ResolvedPolicyPush } from "../../../src/transport/policy-push/resolve.js";

/** A uniform 7-day daily-limit list of `seconds`. */
function uniformDaily(seconds: number): number[] {
  return Array.from({ length: 7 }, () => seconds);
}

/** Build a `WeeklyAllowedWindows` from a partial weekday→windows map. */
function weekly(entries: Partial<Record<IsoWeekday, readonly TimeWindow[]>>): WeeklyAllowedWindows {
  const map = new Map<IsoWeekday, readonly TimeWindow[]>();
  for (const [day, windows] of Object.entries(entries)) {
    if (windows !== undefined) map.set(Number(day) as IsoWeekday, windows);
  }
  return map;
}

/** A resolved push with the all-null/empty base, overridable per field. */
function push(overrides: Partial<ResolvedPolicyPush> = {}): ResolvedPolicyPush {
  return {
    perWeekdaySeconds: null,
    weeklySeconds: null,
    monthlySeconds: null,
    weekly: weekly({}),
    ...overrides,
  };
}

const TWO_HOURS = 2 * 3600;
const TWO_AND_A_HALF_HOURS = 2 * 3600 + 30 * 60;

describe("formatDuration", () => {
  it("renders hours and minutes", () => {
    expect(formatDuration(TWO_AND_A_HALF_HOURS)).toBe("2h 30m");
  });

  it("renders whole hours without a minute part", () => {
    expect(formatDuration(TWO_HOURS)).toBe("2h");
  });

  it("renders sub-hour durations as minutes", () => {
    expect(formatDuration(45 * 60)).toBe("45m");
  });

  it("renders zero as 0m", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("truncates stray seconds to whole minutes", () => {
    expect(formatDuration(90)).toBe("1m");
  });
});

describe("diffResolvedPush — no changes", () => {
  it("reports hasChanges=false for identical pushes", () => {
    const a = push({ perWeekdaySeconds: uniformDaily(TWO_HOURS), weeklySeconds: 10 * 3600 });
    const diff = diffResolvedPush(a, push({ ...a }));
    expect(diff.hasChanges).toBe(false);
    expect(diff.changes).toEqual([]);
  });

  it("treats equal allowed-window grids as unchanged regardless of map identity", () => {
    const w: TimeWindow[] = [{ start: 480, end: 1260 }];
    const before = push({ weekly: weekly({ 1: w, 2: w }) });
    const after = push({
      weekly: weekly({ 1: [{ start: 480, end: 1260 }], 2: [{ start: 480, end: 1260 }] }),
    });
    expect(diffResolvedPush(before, after).hasChanges).toBe(false);
  });
});

describe("diffResolvedPush — daily overall limit", () => {
  it("emits one whole-week row when a uniform limit changes", () => {
    const before = push({ perWeekdaySeconds: uniformDaily(TWO_HOURS) });
    const after = push({ perWeekdaySeconds: uniformDaily(TWO_AND_A_HALF_HOURS) });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      field: "daily-overall",
      kind: "changed",
      weekday: null,
      before: "2h",
      after: "2h 30m",
      summary: "Daily overall limit: 2h → 2h 30m",
    });
  });

  it("marks an added daily limit (none → value)", () => {
    const diff = diffResolvedPush(push(), push({ perWeekdaySeconds: uniformDaily(TWO_HOURS) }));
    expect(diff.changes[0]).toMatchObject({
      field: "daily-overall",
      kind: "added",
      before: null,
      after: "2h",
      summary: "Daily overall limit: no limit → 2h",
    });
  });

  it("marks a removed daily limit (value → none)", () => {
    const diff = diffResolvedPush(push({ perWeekdaySeconds: uniformDaily(TWO_HOURS) }), push());
    expect(diff.changes[0]).toMatchObject({
      field: "daily-overall",
      kind: "removed",
      before: "2h",
      after: null,
    });
  });

  it("emits per-weekday rows only for the days that differ when not uniform", () => {
    // Weekend bumped to 3h, weekdays stay 2h (a weekday-varying #141-shaped push).
    const before = push({ perWeekdaySeconds: uniformDaily(TWO_HOURS) });
    const weekendBump = [TWO_HOURS, TWO_HOURS, TWO_HOURS, TWO_HOURS, TWO_HOURS, 3 * 3600, 3 * 3600];
    const after = push({ perWeekdaySeconds: weekendBump });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes).toHaveLength(2);
    expect(diff.changes.map((c) => c.weekday)).toEqual([6, 7]);
    expect(diff.changes[0]).toMatchObject({
      field: "daily-overall",
      weekday: 6,
      summary: "Daily overall limit (Sat): 2h → 3h",
    });
  });

  it("emits no daily row when both sides have no daily limit", () => {
    const diff = diffResolvedPush(push(), push());
    expect(diff.changes.some((c) => c.field === "daily-overall")).toBe(false);
  });

  it("adds per-weekday rows when a weekday-varying limit replaces no limit", () => {
    // before: no daily limit at all; after: weekday 2h, weekend 3h (non-uniform).
    const weekendBump = [TWO_HOURS, TWO_HOURS, TWO_HOURS, TWO_HOURS, TWO_HOURS, 3 * 3600, 3 * 3600];
    const diff = diffResolvedPush(push(), push({ perWeekdaySeconds: weekendBump }));
    expect(diff.changes).toHaveLength(7);
    expect(diff.changes.every((c) => c.kind === "added" && c.before === null)).toBe(true);
    expect(diff.changes[5]).toMatchObject({
      weekday: 6,
      after: "3h",
      summary: "Daily overall limit (Sat): no limit → 3h",
    });
  });
});

describe("diffResolvedPush — rolling weekly/monthly limits", () => {
  it("reports a weekly limit change", () => {
    const before = push({ weeklySeconds: 10 * 3600 });
    const after = push({ weeklySeconds: 12 * 3600 });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      field: "weekly-limit",
      kind: "changed",
      weekday: null,
      summary: "Weekly overall limit: 10h → 12h",
    });
  });

  it("reports an added monthly limit", () => {
    const diff = diffResolvedPush(push(), push({ monthlySeconds: 40 * 3600 }));
    expect(diff.changes[0]).toMatchObject({
      field: "monthly-limit",
      kind: "added",
      before: null,
      after: "40h",
    });
  });
});

describe("diffResolvedPush — allowed-hours grid", () => {
  it("marks a window added when a day goes from denied to allowed", () => {
    const after = push({ weekly: weekly({ 1: [{ start: 480, end: 1260 }] }) });
    const diff = diffResolvedPush(push(), after);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      field: "allowed-hours",
      kind: "added",
      weekday: 1,
      before: "none",
      after: "08:00–21:00",
      summary: "Allowed hours (Mon): none → 08:00–21:00",
    });
  });

  it("marks a window removed when a day goes from allowed to fully denied (week still has an allowed day)", () => {
    // Mon stays allowed (so the grid is still pushed); Wed loses its window.
    const before = push({
      weekly: weekly({ 1: [{ start: 480, end: 1260 }], 3: [{ start: 0, end: 1440 }] }),
    });
    const after = push({ weekly: weekly({ 1: [{ start: 480, end: 1260 }] }) });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      field: "allowed-hours",
      kind: "removed",
      weekday: 3,
      before: "00:00–24:00",
      after: "none",
    });
  });

  it("marks a window changed and renders multiple windows", () => {
    const before = push({ weekly: weekly({ 5: [{ start: 480, end: 1260 }] }) });
    const after = push({
      weekly: weekly({
        5: [
          { start: 360, end: 720 },
          { start: 780, end: 1260 },
        ],
      }),
    });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes[0]).toMatchObject({
      field: "allowed-hours",
      kind: "changed",
      weekday: 5,
      before: "08:00–21:00",
      after: "06:00–12:00, 13:00–21:00",
    });
  });

  it("emits one row per differing weekday, ascending", () => {
    const before = push({ weekly: weekly({ 1: [{ start: 480, end: 1260 }] }) });
    const after = push({
      weekly: weekly({ 1: [{ start: 480, end: 1260 }], 6: [{ start: 540, end: 1320 }] }),
    });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes.map((c) => c.weekday)).toEqual([6]);
  });

  it("suppresses allowed-hours rows when the proposed week is fully denied (executor skips the push)", () => {
    // before allows Mon–Fri; after denies every day. The executor would NOT
    // call setWeeklyAllowedHours (no allowed weekday), so the preview must not
    // claim the grid changes — even though the windows literally differ.
    const before = push({
      weekly: weekly({
        1: [{ start: 480, end: 1260 }],
        2: [{ start: 480, end: 1260 }],
      }),
    });
    const after = push({ weekly: weekly({}) });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes.some((c) => c.field === "allowed-hours")).toBe(false);
  });
});

describe("diffResolvedPush — combined ordering", () => {
  it("orders rows daily → weekly → monthly → allowed-hours", () => {
    const before = push({
      perWeekdaySeconds: uniformDaily(TWO_HOURS),
      weeklySeconds: 10 * 3600,
      monthlySeconds: 40 * 3600,
      weekly: weekly({ 1: [{ start: 480, end: 1260 }] }),
    });
    const after = push({
      perWeekdaySeconds: uniformDaily(TWO_AND_A_HALF_HOURS),
      weeklySeconds: 11 * 3600,
      monthlySeconds: 41 * 3600,
      weekly: weekly({ 1: [{ start: 420, end: 1260 }] }),
    });
    const diff = diffResolvedPush(before, after);
    expect(diff.changes.map((c) => c.field)).toEqual([
      "daily-overall",
      "weekly-limit",
      "monthly-limit",
      "allowed-hours",
    ]);
    expect(diff.hasChanges).toBe(true);
  });
});
