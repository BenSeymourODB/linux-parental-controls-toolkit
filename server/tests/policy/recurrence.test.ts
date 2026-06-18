/**
 * The reserved recurrence + date-scoping validators (#146 / ADR 0005). These
 * are the API-boundary half of the reservation: the zod refinements must mirror
 * the schema's `CHECK` constraints (exercised in `schema.test.ts`) field for
 * field, so a request rejected by one would be rejected by the other.
 */
import { describe, expect, it } from "vitest";

import {
  MINUTE_OF_DAY_MAX,
  WEEKDAY_MASK_MAX,
  WEEKDAY_MASK_MIN,
  minuteOfDaySchema,
  scheduleRecurrenceSchema,
  weekdayMaskSchema,
} from "../../src/policy/recurrence.js";

describe("weekdayMaskSchema", () => {
  it("accepts the inclusive 1..127 bounds", () => {
    expect(weekdayMaskSchema.parse(WEEKDAY_MASK_MIN)).toBe(1);
    expect(weekdayMaskSchema.parse(WEEKDAY_MASK_MAX)).toBe(127);
    expect(weekdayMaskSchema.parse(0b0011111)).toBe(31);
  });

  it("rejects an empty mask, an out-of-range mask, and a non-integer", () => {
    expect(weekdayMaskSchema.safeParse(0).success).toBe(false);
    expect(weekdayMaskSchema.safeParse(128).success).toBe(false);
    expect(weekdayMaskSchema.safeParse(3.5).success).toBe(false);
  });
});

describe("minuteOfDaySchema", () => {
  it("accepts 0..1440 and rejects values outside it", () => {
    expect(minuteOfDaySchema.parse(0)).toBe(0);
    expect(minuteOfDaySchema.parse(MINUTE_OF_DAY_MAX)).toBe(1440);
    expect(minuteOfDaySchema.safeParse(-1).success).toBe(false);
    expect(minuteOfDaySchema.safeParse(1441).success).toBe(false);
  });
});

describe("scheduleRecurrenceSchema", () => {
  it("defaults every field to null (the always-on degenerate)", () => {
    expect(scheduleRecurrenceSchema.parse({})).toStrictEqual({
      recurrenceDays: null,
      recurrenceStartMinute: null,
      recurrenceEndMinute: null,
      effectiveFrom: null,
      effectiveTo: null,
    });
  });

  it("accepts a fully-specified, coherent window", () => {
    const parsed = scheduleRecurrenceSchema.parse({
      recurrenceDays: 0b0011111,
      recurrenceStartMinute: 960,
      recurrenceEndMinute: 1080,
      effectiveFrom: "2026-03-25T00:00:00Z",
      effectiveTo: "2026-04-02T00:00:00Z",
    });
    expect(parsed.recurrenceStartMinute).toBe(960);
    expect(parsed.effectiveTo).toBe("2026-04-02T00:00:00Z");
  });

  it("requires the two minute bounds to be set together", () => {
    const startOnly = scheduleRecurrenceSchema.safeParse({ recurrenceStartMinute: 600 });
    expect(startOnly.success).toBe(false);
    if (!startOnly.success) {
      expect(startOnly.error.issues[0]?.path).toContain("recurrenceEndMinute");
    }

    const endOnly = scheduleRecurrenceSchema.safeParse({ recurrenceEndMinute: 600 });
    expect(endOnly.success).toBe(false);
    if (!endOnly.success) {
      expect(endOnly.error.issues[0]?.path).toContain("recurrenceStartMinute");
    }
  });

  it("rejects a non-positive-length intra-day window", () => {
    expect(
      scheduleRecurrenceSchema.safeParse({ recurrenceStartMinute: 600, recurrenceEndMinute: 600 })
        .success,
    ).toBe(false);
    expect(
      scheduleRecurrenceSchema.safeParse({ recurrenceStartMinute: 700, recurrenceEndMinute: 600 })
        .success,
    ).toBe(false);
  });

  it("rejects an empty or inverted effective window but allows an open-ended one", () => {
    expect(
      scheduleRecurrenceSchema.safeParse({
        effectiveFrom: "2026-03-25T00:00:00Z",
        effectiveTo: "2026-03-25T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      scheduleRecurrenceSchema.safeParse({
        effectiveFrom: "2026-04-02T00:00:00Z",
        effectiveTo: "2026-03-25T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      scheduleRecurrenceSchema.safeParse({ effectiveFrom: "2026-03-25T00:00:00Z" }).success,
    ).toBe(true);
    expect(
      scheduleRecurrenceSchema.safeParse({ effectiveTo: "2026-03-25T00:00:00Z" }).success,
    ).toBe(true);
  });

  it("rejects a non-ISO effective instant", () => {
    expect(scheduleRecurrenceSchema.safeParse({ effectiveFrom: "next tuesday" }).success).toBe(
      false,
    );
  });
});
