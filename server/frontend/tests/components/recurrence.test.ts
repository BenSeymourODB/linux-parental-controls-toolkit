/**
 * Unit tests for the pure recurrence authoring helpers (#361), the frontend
 * mirror of `server/src/policy/recurrence.ts`. These are plain functions (no
 * DOM), but they live under `tests/components/` so the `components` project's
 * SvelteKit `$lib` alias resolves the import; the jsdom environment is a
 * harmless superset for pure code.
 *
 * Date conversions are asserted as **round-trips** rather than against a fixed
 * offset, so they hold in any timezone the runner happens to use.
 */
import { describe, expect, it } from "vitest";

import {
  MINUTES_PER_DAY,
  dayChecked,
  dateInputToInstant,
  instantToDateInput,
  minutesToTimeInput,
  timeInputToMinutes,
  toggleDay,
  validateRecurrence,
  type RecurrenceValue,
} from "../../src/lib/recurrence.js";

/** A valid, always-on (degenerate) recurrence value; override at will. */
function value(overrides: Partial<RecurrenceValue> = {}): RecurrenceValue {
  return {
    recurrenceDays: null,
    recurrenceStartMinute: null,
    recurrenceEndMinute: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

describe("weekday mask helpers", () => {
  it("reports no day checked for the null (every-day) mask", () => {
    for (let i = 0; i < 7; i++) {
      expect(dayChecked(null, i)).toBe(false);
    }
  });

  it("decodes bit 0 = Monday and bit 6 = Sunday", () => {
    expect(dayChecked(0b0000001, 0)).toBe(true); // Mon
    expect(dayChecked(0b0000001, 1)).toBe(false); // Tue
    expect(dayChecked(0b1000000, 6)).toBe(true); // Sun
  });

  it("sets a bit, building the Mon–Fri mask incrementally", () => {
    let mask: number | null = null;
    for (let i = 0; i < 5; i++) {
      mask = toggleDay(mask, i, true);
    }
    expect(mask).toBe(0b0011111); // 31 = Mon–Fri
  });

  it("collapses to null (every day) when the last bit is cleared", () => {
    expect(toggleDay(0b0000001, 0, false)).toBeNull();
  });

  it("clears one bit of many without collapsing", () => {
    // Mon–Fri (31) minus Wednesday (bit 2) → 0b0011011 = 27.
    expect(toggleDay(0b0011111, 2, false)).toBe(0b0011011);
  });
});

describe("time-window <-> minutes", () => {
  it("formats minutes as zero-padded HH:MM and null as empty", () => {
    expect(minutesToTimeInput(null)).toBe("");
    expect(minutesToTimeInput(0)).toBe("00:00");
    expect(minutesToTimeInput(540)).toBe("09:00");
    expect(minutesToTimeInput(1290)).toBe("21:30");
    expect(minutesToTimeInput(1439)).toBe("23:59");
  });

  it("renders the end-of-day sentinel 1440 as 00:00", () => {
    expect(minutesToTimeInput(MINUTES_PER_DAY)).toBe("00:00");
  });

  it("parses HH:MM to minutes and empty to null", () => {
    expect(timeInputToMinutes("", false)).toBeNull();
    expect(timeInputToMinutes("09:00", false)).toBe(540);
    expect(timeInputToMinutes("21:30", false)).toBe(1290);
  });

  it("maps an end of 00:00 to 1440 (end of day) but a start of 00:00 to 0", () => {
    expect(timeInputToMinutes("00:00", true)).toBe(MINUTES_PER_DAY);
    expect(timeInputToMinutes("00:00", false)).toBe(0);
  });

  it("rejects a malformed value as null", () => {
    expect(timeInputToMinutes("not-a-time", false)).toBeNull();
  });

  it("round-trips a normal window and the end-of-day case", () => {
    expect(timeInputToMinutes(minutesToTimeInput(960), false)).toBe(960); // 16:00
    // 21:00 → "21:00" → 1260; and 1440 → "00:00" → 1440 (as an end).
    expect(timeInputToMinutes(minutesToTimeInput(1260), false)).toBe(1260);
    expect(timeInputToMinutes(minutesToTimeInput(MINUTES_PER_DAY), true)).toBe(MINUTES_PER_DAY);
  });
});

describe("date-scope <-> instant", () => {
  it("maps null to empty and back", () => {
    expect(instantToDateInput(null)).toBe("");
    expect(dateInputToInstant("")).toBeNull();
  });

  it("round-trips a calendar day regardless of the runner timezone", () => {
    // Local-midnight conversion means author → store → re-open is stable.
    for (const day of ["2026-01-01", "2026-07-02", "2026-12-31"]) {
      const instant = dateInputToInstant(day);
      expect(instant).not.toBeNull();
      expect(instantToDateInput(instant)).toBe(day);
    }
  });

  it("produces a Zod .datetime()-compatible instant (UTC, with Z)", () => {
    const instant = dateInputToInstant("2026-07-02");
    expect(instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("treats a malformed date as null", () => {
    expect(dateInputToInstant("nope")).toBeNull();
  });
});

describe("validateRecurrence (mirrors the DTO cross-field invariants)", () => {
  it("accepts the always-on degenerate value", () => {
    expect(validateRecurrence(value())).toBeNull();
  });

  it("accepts a full, valid window + date scope", () => {
    expect(
      validateRecurrence(
        value({
          recurrenceDays: 0b0011111,
          recurrenceStartMinute: 960,
          recurrenceEndMinute: 1080,
          effectiveFrom: "2026-03-01T00:00:00.000Z",
          effectiveTo: "2026-09-01T00:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });

  it("rejects only one half of the minute pair", () => {
    expect(validateRecurrence(value({ recurrenceStartMinute: 540 }))).toMatch(/both a start and end/i);
    expect(validateRecurrence(value({ recurrenceEndMinute: 540 }))).toMatch(/both a start and end/i);
  });

  it("rejects end <= start", () => {
    expect(
      validateRecurrence(value({ recurrenceStartMinute: 1080, recurrenceEndMinute: 1080 })),
    ).toMatch(/end time must be after/i);
    expect(
      validateRecurrence(value({ recurrenceStartMinute: 1080, recurrenceEndMinute: 960 })),
    ).toMatch(/end time must be after/i);
  });

  it("rejects effectiveTo <= effectiveFrom", () => {
    expect(
      validateRecurrence(
        value({
          effectiveFrom: "2026-09-01T00:00:00.000Z",
          effectiveTo: "2026-03-01T00:00:00.000Z",
        }),
      ),
    ).toMatch(/end date must be after/i);
  });

  it("accepts an open-ended date scope (one side null)", () => {
    expect(validateRecurrence(value({ effectiveFrom: "2026-03-01T00:00:00.000Z" }))).toBeNull();
    expect(validateRecurrence(value({ effectiveTo: "2026-09-01T00:00:00.000Z" }))).toBeNull();
  });
});
