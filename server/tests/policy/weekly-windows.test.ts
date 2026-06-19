/**
 * Weekly recurring allowed-access windows (#140).
 *
 * Drives the real effective-policy resolver over the seven local days of a
 * reference week, asserting the per-ISO-weekday `allowedWindows` keying:
 * weekday-restricted recurrence, intra-day windows, denied days, and that the
 * map is anchored to the week containing the reference instant.
 */
import { describe, expect, it } from "vitest";

import { resolveWeeklyAllowedWindows } from "../../src/policy/weekly-windows.js";
import type { ScheduleRule } from "../../src/policy/schedule-precedence.js";

/** ISO-weekday bits for a Mon–Fri mask (bits 0–4). */
const WEEKDAYS = 0b0011111;
/** All seven weekdays set. */
const EVERY_DAY = 0b1111111;

/** Build a {@link ScheduleRule}, defaulting to an always-on `overall` allow. */
function mkRule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
  return {
    id: 1,
    ordinal: 0,
    targetKind: "overall",
    targetId: null,
    recurrenceDays: null,
    recurrenceStartMinute: null,
    recurrenceEndMinute: null,
    effectiveFrom: null,
    effectiveTo: null,
    action: "allow",
    ...overrides,
  };
}

// A Wednesday, so the reference is mid-week and the Monday anchor must step back.
const REFERENCE = new Date("2024-06-05T15:00:00Z");

describe("resolveWeeklyAllowedWindows", () => {
  it("returns one entry per ISO weekday", () => {
    const byWeekday = resolveWeeklyAllowedWindows({
      schedules: [],
      tz: "UTC",
      reference: REFERENCE,
    });
    expect([...byWeekday.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("treats no schedule as unrestricted every day (baseline allow)", () => {
    const byWeekday = resolveWeeklyAllowedWindows({
      schedules: [],
      tz: "UTC",
      reference: REFERENCE,
    });
    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      expect(byWeekday.get(weekday)).toEqual([{ start: 0, end: 1440 }]);
    }
  });

  it("projects a Mon–Fri intra-day window onto the weekdays only", () => {
    // allow 16:00–18:00 on weekdays (specific, first), deny everything (last).
    const schedules: ScheduleRule[] = [
      mkRule({
        id: 1,
        ordinal: 0,
        action: "allow",
        recurrenceDays: WEEKDAYS,
        recurrenceStartMinute: 16 * 60,
        recurrenceEndMinute: 18 * 60,
      }),
      mkRule({ id: 2, ordinal: 1, action: "deny" }),
    ];
    const byWeekday = resolveWeeklyAllowedWindows({ schedules, tz: "UTC", reference: REFERENCE });
    for (const weekday of [1, 2, 3, 4, 5]) {
      expect(byWeekday.get(weekday)).toEqual([{ start: 960, end: 1080 }]);
    }
    // Weekend: only the baseline deny applies → no allowed windows.
    expect(byWeekday.get(6)).toEqual([]);
    expect(byWeekday.get(7)).toEqual([]);
  });

  it("denies a day a deny-everything daily rule covers", () => {
    const schedules: ScheduleRule[] = [mkRule({ recurrenceDays: EVERY_DAY, action: "deny" })];
    const byWeekday = resolveWeeklyAllowedWindows({ schedules, tz: "UTC", reference: REFERENCE });
    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      expect(byWeekday.get(weekday)).toEqual([]);
    }
  });

  it("anchors the week on the reference instant (any day in the week → same map)", () => {
    const schedules: ScheduleRule[] = [
      mkRule({
        id: 1,
        ordinal: 0,
        action: "allow",
        recurrenceDays: 0b0000001, // Monday only
        recurrenceStartMinute: 9 * 60,
        recurrenceEndMinute: 12 * 60,
      }),
      mkRule({ id: 2, ordinal: 1, action: "deny" }),
    ];
    const monday = resolveWeeklyAllowedWindows({
      schedules,
      tz: "UTC",
      reference: new Date("2024-06-03T00:00:00Z"), // Monday
    });
    const sunday = resolveWeeklyAllowedWindows({
      schedules,
      tz: "UTC",
      reference: new Date("2024-06-09T23:00:00Z"), // the Sunday of the same ISO week
    });
    expect(monday.get(1)).toEqual([{ start: 540, end: 720 }]);
    expect(sunday.get(1)).toEqual([{ start: 540, end: 720 }]);
  });
});
