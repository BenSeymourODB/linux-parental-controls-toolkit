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
import type { ExceptionInput } from "../../src/policy/resolve.js";
import type { ScheduleRule } from "../../src/policy/schedule-precedence.js";
import { buildWeeklyAllowedHoursCommands } from "../../src/transport/timekpr/allowed-hours.js";

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
    for (const weekday of [1, 2, 3, 4, 5, 6, 7] as const) {
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
    for (const weekday of [1, 2, 3, 4, 5] as const) {
      expect(byWeekday.get(weekday)).toEqual([{ start: 960, end: 1080 }]);
    }
    // Weekend: only the baseline deny applies → no allowed windows.
    expect(byWeekday.get(6)).toEqual([]);
    expect(byWeekday.get(7)).toEqual([]);
  });

  it("denies a day a deny-everything daily rule covers", () => {
    const schedules: ScheduleRule[] = [mkRule({ recurrenceDays: EVERY_DAY, action: "deny" })];
    const byWeekday = resolveWeeklyAllowedWindows({ schedules, tz: "UTC", reference: REFERENCE });
    for (const weekday of [1, 2, 3, 4, 5, 6, 7] as const) {
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

  it("anchors and projects correctly across a spring-forward DST week", () => {
    // 2024-03-10 is the US spring-forward day; the reference is the Sunday of
    // that ISO week (Mon 2024-03-04 … Sun 2024-03-10). Wall-clock windows are
    // DST-independent, so the keying and windows must be unaffected.
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
    const byWeekday = resolveWeeklyAllowedWindows({
      schedules,
      tz: "America/New_York",
      reference: new Date("2024-03-10T16:00:00Z"), // after the 02:00→03:00 jump
    });
    expect([...byWeekday.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const weekday of [1, 2, 3, 4, 5] as const) {
      expect(byWeekday.get(weekday)).toEqual([{ start: 960, end: 1080 }]);
    }
    expect(byWeekday.get(6)).toEqual([]);
    expect(byWeekday.get(7)).toEqual([]);
  });

  it("is unchanged when passed an empty exceptions array (default recurring grid)", () => {
    const schedules: ScheduleRule[] = [
      mkRule({
        id: 1,
        action: "allow",
        recurrenceDays: WEEKDAYS,
        recurrenceStartMinute: 16 * 60,
        recurrenceEndMinute: 18 * 60,
      }),
      mkRule({ id: 2, ordinal: 1, action: "deny" }),
    ];
    const withField = resolveWeeklyAllowedWindows({
      schedules,
      tz: "UTC",
      reference: REFERENCE,
      exceptions: [],
    });
    const without = resolveWeeklyAllowedWindows({ schedules, tz: "UTC", reference: REFERENCE });
    for (const weekday of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(withField.get(weekday)).toEqual(without.get(weekday));
    }
  });

  it("feeds buildWeeklyAllowedHoursCommands end-to-end (#140 push)", () => {
    // allow 16:00–18:00 Mon–Fri; the bridge's output drives the merged
    // transport mapping directly (the resolver→timekpra glue this module adds).
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
    const weekly = resolveWeeklyAllowedWindows({ schedules, tz: "UTC", reference: REFERENCE });
    const commands = buildWeeklyAllowedHoursCommands("alice", weekly);
    expect(commands).toEqual([
      ["--setalloweddays", "alice", "1;2;3;4;5"],
      ["--setallowedhours", "alice", "1", "16;17"],
      ["--setallowedhours", "alice", "2", "16;17"],
      ["--setallowedhours", "alice", "3", "16;17"],
      ["--setallowedhours", "alice", "4", "16;17"],
      ["--setallowedhours", "alice", "5", "16;17"],
    ]);
  });
});

/**
 * Build an {@link ExceptionInput}, defaulting to a whole-Wednesday (2024-06-05,
 * the reference day) `overall` `deny` in UTC.
 */
function mkException(overrides: Partial<ExceptionInput> = {}): ExceptionInput {
  return {
    id: 1,
    targetKind: "overall",
    targetId: null,
    action: "deny",
    effectiveFrom: new Date("2024-06-05T00:00:00Z"),
    expiresAt: new Date("2024-06-06T00:00:00Z"),
    createdAt: new Date("2024-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("resolveWeeklyAllowedWindows — date-specific overrides (#399)", () => {
  it("denies only the weekday a whole-day deny override covers, leaving others standing", () => {
    // No recurring schedule → every day baseline-allowed; the override denies Wed.
    const byWeekday = resolveWeeklyAllowedWindows({
      schedules: [],
      tz: "UTC",
      reference: REFERENCE,
      exceptions: [mkException()],
    });
    // Wednesday (weekday 3, the covered day) is now denied all day…
    expect(byWeekday.get(3)).toEqual([]);
    // …while every other day keeps the standing unrestricted grid.
    for (const weekday of [1, 2, 4, 5, 6, 7] as const) {
      expect(byWeekday.get(weekday)).toEqual([{ start: 0, end: 1440 }]);
    }
  });

  it("widens the covered day past a standing bedtime deny via an extend override", () => {
    // Standing: allow 09:00–17:00 every day, deny the rest (a bedtime cut-off).
    const schedules: ScheduleRule[] = [
      mkRule({
        id: 1,
        action: "allow",
        recurrenceDays: EVERY_DAY,
        recurrenceStartMinute: 9 * 60,
        recurrenceEndMinute: 17 * 60,
      }),
      mkRule({ id: 2, ordinal: 1, action: "deny" }),
    ];
    // "allow until 21:00 this Wednesday" — an extend union past the 17:00 deny.
    const exception = mkException({
      action: "extend",
      effectiveFrom: new Date("2024-06-05T00:00:00Z"),
      expiresAt: new Date("2024-06-05T21:00:00Z"),
    });
    const overridden = resolveWeeklyAllowedWindows({
      schedules,
      tz: "UTC",
      reference: REFERENCE,
      exceptions: [exception],
    });
    const standing = resolveWeeklyAllowedWindows({ schedules, tz: "UTC", reference: REFERENCE });
    // Wednesday now reaches to 21:00 (1260); other days keep the 09:00–17:00 grid.
    expect(overridden.get(3)).toEqual([{ start: 0, end: 21 * 60 }]);
    expect(standing.get(3)).toEqual([{ start: 9 * 60, end: 17 * 60 }]);
    for (const weekday of [1, 2, 4, 5, 6, 7] as const) {
      expect(overridden.get(weekday)).toEqual([{ start: 9 * 60, end: 17 * 60 }]);
    }
  });

  it("ignores an override whose window falls outside the resolved week", () => {
    // An override for a date in a later week must not touch this week's grid.
    const nextWeek = mkException({
      effectiveFrom: new Date("2024-06-12T00:00:00Z"),
      expiresAt: new Date("2024-06-13T00:00:00Z"),
    });
    const byWeekday = resolveWeeklyAllowedWindows({
      schedules: [],
      tz: "UTC",
      reference: REFERENCE,
      exceptions: [nextWeek],
    });
    for (const weekday of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(byWeekday.get(weekday)).toEqual([{ start: 0, end: 1440 }]);
    }
  });
});
