/**
 * Unit tests for the pure policy → `timekpra`-inputs resolver (#201): the daily
 * overall limit (from the resolver), the rolling weekly/monthly limits (from
 * overall budgets), and the recurring allowed-hours grid (from #140).
 */
import { describe, expect, it } from "vitest";

import type { BudgetInput } from "../../../src/policy/resolve.js";
import type { ScheduleRule } from "../../../src/policy/schedule-precedence.js";
import { buildWeeklyAllowedHoursCommands } from "../../../src/transport/timekpr/allowed-hours.js";
import {
  resolvePolicyPush,
  unrestrictedPolicyPush,
} from "../../../src/transport/policy-push/resolve.js";

/** A fixed mid-week instant (Wed 2026-06-17, 12:00 UTC) for determinism. */
const NOW = new Date("2026-06-17T12:00:00Z");

/** Build a `ScheduleRule` with the always-on degenerate as the base. */
function rule(overrides: Partial<ScheduleRule>): ScheduleRule {
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

describe("resolvePolicyPush", () => {
  it("returns null limits and an all-day-allowed week when nothing is defined", () => {
    const resolved = resolvePolicyPush({ tz: "UTC", schedules: [], budgets: [], now: NOW });

    expect(resolved.perWeekdaySeconds).toBeNull();
    expect(resolved.weeklySeconds).toBeNull();
    expect(resolved.monthlySeconds).toBeNull();
    // Baseline allow: each ISO weekday is unrestricted [{0, 1440}].
    for (let weekday = 1 as const; weekday <= 7; weekday += 1) {
      expect(resolved.weekly.get(weekday as 1)).toEqual([{ start: 0, end: 1440 }]);
    }
  });

  it("replicates the daily overall limit across all seven weekdays", () => {
    const budgets: BudgetInput[] = [
      { scope: "overall", targetId: null, window: "daily", secondsAllowed: 7200 },
    ];
    const resolved = resolvePolicyPush({ tz: "UTC", schedules: [], budgets, now: NOW });

    expect(resolved.perWeekdaySeconds).toEqual([7200, 7200, 7200, 7200, 7200, 7200, 7200]);
  });

  it("sums overall daily budgets into the per-weekday limit", () => {
    const budgets: BudgetInput[] = [
      { scope: "overall", targetId: null, window: "daily", secondsAllowed: 3600 },
      { scope: "overall", targetId: null, window: "daily", secondsAllowed: 1800 },
    ];
    const resolved = resolvePolicyPush({ tz: "UTC", schedules: [], budgets, now: NOW });
    expect(resolved.perWeekdaySeconds?.[0]).toBe(5400);
  });

  it("reads rolling weekly/monthly limits from the overall budgets", () => {
    const budgets: BudgetInput[] = [
      { scope: "overall", targetId: null, window: "weekly", secondsAllowed: 36000 },
      { scope: "overall", targetId: null, window: "monthly", secondsAllowed: 100000 },
    ];
    const resolved = resolvePolicyPush({ tz: "UTC", schedules: [], budgets, now: NOW });

    expect(resolved.weeklySeconds).toBe(36000);
    expect(resolved.monthlySeconds).toBe(100000);
    // A weekly/monthly-only policy still has no daily limit.
    expect(resolved.perWeekdaySeconds).toBeNull();
  });

  it("ignores per-activity budgets when computing the overall rolling limits", () => {
    const budgets: BudgetInput[] = [
      { scope: "activity", targetId: 5, window: "weekly", secondsAllowed: 999 },
    ];
    const resolved = resolvePolicyPush({ tz: "UTC", schedules: [], budgets, now: NOW });
    expect(resolved.weeklySeconds).toBeNull();
  });

  it("carves a recurring deny window out of every day's allowed hours", () => {
    // Deny 00:00–06:00 every day → allowed [06:00, 24:00).
    const schedules: ScheduleRule[] = [
      rule({ action: "deny", recurrenceStartMinute: 0, recurrenceEndMinute: 360 }),
    ];
    const resolved = resolvePolicyPush({ tz: "UTC", schedules, budgets: [], now: NOW });

    expect(resolved.weekly.get(1)).toEqual([{ start: 360, end: 1440 }]);
    expect(resolved.weekly.get(7)).toEqual([{ start: 360, end: 1440 }]);
  });

  describe("unrestrictedPolicyPush (#253 unmanage)", () => {
    it("is the maximal allowance with all hours allowed every day", () => {
      const resolved = unrestrictedPolicyPush();

      // 86400s (a whole day) for each of the 7 weekdays.
      expect(resolved.perWeekdaySeconds).toEqual(Array.from({ length: 7 }, () => 86_400));
      expect(resolved.weeklySeconds).toBe(86_400 * 7);
      expect(resolved.monthlySeconds).toBe(86_400 * 31);

      // Every ISO weekday allows the whole day, so the grid is never empty and
      // the executor's full-lockout allowed-hours skip can never trigger here.
      expect(resolved.weekly.size).toBe(7);
      for (const day of [1, 2, 3, 4, 5, 6, 7] as const) {
        expect(resolved.weekly.get(day)).toEqual([{ start: 0, end: 1440 }]);
      }
    });

    it("maps to valid timekpra argv: every day allowed, all 24 hours, collapsed to ALL", () => {
      // Prove the unmanage grid survives the real allowed-hours builder (not just
      // the map shape): a single --setalloweddays for all 7 days, then one
      // collapsed --setallowedhours USER ALL listing the 24 bare (whole) hours.
      const commands = buildWeeklyAllowedHoursCommands("alice", unrestrictedPolicyPush().weekly);
      expect(commands).toEqual([
        ["--setalloweddays", "alice", "1;2;3;4;5;6;7"],
        [
          "--setallowedhours",
          "alice",
          "ALL",
          "0;1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20;21;22;23",
        ],
      ]);
    });
  });
});
