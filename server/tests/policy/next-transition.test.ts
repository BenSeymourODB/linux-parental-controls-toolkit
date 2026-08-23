/**
 * Unit tests for the pure next-transition boundary walk (#110).
 *
 * Exercises `isAccessAllowedAt` and `nextOverallTransition` against the window
 * shapes the effective-policy resolver produces — unrestricted (`{0,1440}`),
 * denied-all-day (`[]`), a single bedtime cut-off, a mid-day gap — and the
 * today→tomorrow hand-off including the midnight crossing.
 */
import { describe, expect, it } from "vitest";

import {
  isAccessAllowedAt,
  nextOverallTransition,
  type AllowedWindow,
} from "../../src/policy/next-transition.js";

const FULL_DAY: AllowedWindow[] = [{ start: 0, end: 1440 }];
const DENIED: AllowedWindow[] = [];
const TODAY = "2026-08-23";
const TOMORROW = "2026-08-24";

describe("isAccessAllowedAt", () => {
  it("treats windows as half-open [start, end)", () => {
    const windows: AllowedWindow[] = [{ start: 540, end: 1260 }]; // 09:00–21:00
    expect(isAccessAllowedAt(539, windows)).toBe(false);
    expect(isAccessAllowedAt(540, windows)).toBe(true);
    expect(isAccessAllowedAt(1259, windows)).toBe(true);
    expect(isAccessAllowedAt(1260, windows)).toBe(false); // end is exclusive
  });

  it("is always true unrestricted and always false denied", () => {
    expect(isAccessAllowedAt(0, FULL_DAY)).toBe(true);
    expect(isAccessAllowedAt(1439, FULL_DAY)).toBe(true);
    expect(isAccessAllowedAt(720, DENIED)).toBe(false);
  });
});

describe("nextOverallTransition — within today", () => {
  it("reports access_ends at a bedtime cut-off while access is open", () => {
    const today: AllowedWindow[] = [{ start: 0, end: 1260 }]; // allowed until 21:00
    // now 20:00 (1200), inside the window.
    expect(nextOverallTransition(today, 1200, TODAY, FULL_DAY, TOMORROW)).toEqual({
      kind: "access_ends",
      localDate: TODAY,
      atMinuteOfDay: 1260,
    });
  });

  it("reports access_resumes at the next window start while in a gap", () => {
    const today: AllowedWindow[] = [
      { start: 0, end: 540 }, // 00:00–09:00
      { start: 900, end: 1440 }, // 15:00–24:00 (school-hours gap 09:00–15:00)
    ];
    // now 10:00 (600), in the gap.
    expect(nextOverallTransition(today, 600, TODAY, FULL_DAY, TOMORROW)).toEqual({
      kind: "access_resumes",
      localDate: TODAY,
      atMinuteOfDay: 900,
    });
  });

  it("picks the earliest boundary after now, not a later one", () => {
    const today: AllowedWindow[] = [
      { start: 0, end: 540 },
      { start: 900, end: 1260 },
    ];
    // now 05:00 (300), inside the first window: the next flip is its end at 540.
    expect(nextOverallTransition(today, 300, TODAY, FULL_DAY, TOMORROW)).toEqual({
      kind: "access_ends",
      localDate: TODAY,
      atMinuteOfDay: 540,
    });
  });

  it("never surfaces the midnight end (1440) as a today transition", () => {
    const today: AllowedWindow[] = [{ start: 720, end: 1440 }]; // allowed noon→midnight
    // now 13:00 (780), inside; the only later boundary is 1440 → look to tomorrow.
    const result = nextOverallTransition(today, 780, TODAY, DENIED, TOMORROW);
    // tomorrow denied all day ⇒ access ends at the midnight crossing.
    expect(result).toEqual({ kind: "access_ends", localDate: TOMORROW, atMinuteOfDay: 0 });
  });
});

describe("nextOverallTransition — spilling into tomorrow", () => {
  it("reports tomorrow's first resume when denied for the rest of today", () => {
    // today denied all day; tomorrow allowed 07:00–21:00.
    const tomorrow: AllowedWindow[] = [{ start: 420, end: 1260 }];
    expect(nextOverallTransition(DENIED, 600, TODAY, tomorrow, TOMORROW)).toEqual({
      kind: "access_resumes",
      localDate: TOMORROW,
      atMinuteOfDay: 420,
    });
  });

  it("reports a resume at midnight when access comes back exactly at the day roll", () => {
    // today denied all day; tomorrow unrestricted ⇒ access resumes at 00:00.
    expect(nextOverallTransition(DENIED, 600, TODAY, FULL_DAY, TOMORROW)).toEqual({
      kind: "access_resumes",
      localDate: TOMORROW,
      atMinuteOfDay: 0,
    });
  });

  it("reports tomorrow's bedtime when today is unrestricted", () => {
    // today unrestricted (no today boundary), tomorrow allowed until 21:00.
    const tomorrow: AllowedWindow[] = [{ start: 0, end: 1260 }];
    expect(nextOverallTransition(FULL_DAY, 800, TODAY, tomorrow, TOMORROW)).toEqual({
      kind: "access_ends",
      localDate: TOMORROW,
      atMinuteOfDay: 1260,
    });
  });

  it("returns null when access never changes (both days unrestricted)", () => {
    expect(nextOverallTransition(FULL_DAY, 720, TODAY, FULL_DAY, TOMORROW)).toBeNull();
  });

  it("returns null when access is denied straight through both days", () => {
    expect(nextOverallTransition(DENIED, 720, TODAY, DENIED, TOMORROW)).toBeNull();
  });

  it("skips a no-op boundary where two windows touch", () => {
    // touching windows: access is continuous 00:00→21:00 across the 09:00 seam.
    const today: AllowedWindow[] = [
      { start: 0, end: 540 },
      { start: 540, end: 1260 },
    ];
    // now 08:00 (480): the 540 seam is not a flip; the next real flip is 1260.
    expect(nextOverallTransition(today, 480, TODAY, FULL_DAY, TOMORROW)).toEqual({
      kind: "access_ends",
      localDate: TODAY,
      atMinuteOfDay: 1260,
    });
  });
});
