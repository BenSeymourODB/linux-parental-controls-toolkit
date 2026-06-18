/**
 * Effective-policy resolution engine (#143).
 *
 * Covers the ADR-0005 "is this rule active at instant *T*?" predicate and the
 * day resolver that composes recurring windows (first-match-wins, ADR 0004),
 * uniform daily budgets, and active grants into the effective picture for a
 * day — all in the user's effective timezone.
 */
import { describe, expect, it } from "vitest";

import {
  effectivePolicy,
  isRuleActiveAt,
  ruleActiveAt,
  type BudgetInput,
  type EffectivePolicyInput,
  type GrantInput,
} from "../../src/policy/resolve.js";
import { resolveEffectiveAction, type ScheduleRule } from "../../src/policy/schedule-precedence.js";

/** ISO-8601 weekday bit for a Monday-only mask (bit 0). */
const MONDAY = 1;
/** All seven weekdays set. */
const EVERY_DAY = 127;

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

/** A resolver input over UTC with empty rows, overridable per test. */
function mkInput(overrides: Partial<EffectivePolicyInput> = {}): EffectivePolicyInput {
  return {
    date: { year: 2024, month: 6, day: 3 }, // a Monday
    tz: "UTC",
    schedules: [],
    budgets: [],
    grants: [],
    ...overrides,
  };
}

describe("isRuleActiveAt — date gate", () => {
  const at = new Date("2024-06-03T12:00:00Z");

  it("always-on rule is active whenever the date gate allows", () => {
    expect(isRuleActiveAt(mkRule(), at, "UTC")).toBe(true);
  });

  it("is inactive before effective_from and active at/after it", () => {
    const rule = mkRule({ effectiveFrom: new Date("2024-06-03T12:00:00Z") });
    expect(isRuleActiveAt(rule, new Date("2024-06-03T11:59:59Z"), "UTC")).toBe(false);
    expect(isRuleActiveAt(rule, at, "UTC")).toBe(true); // inclusive lower bound
  });

  it("treats effective_to as an exclusive upper bound", () => {
    const rule = mkRule({ effectiveTo: new Date("2024-06-03T12:00:00Z") });
    expect(isRuleActiveAt(rule, new Date("2024-06-03T11:59:59Z"), "UTC")).toBe(true);
    expect(isRuleActiveAt(rule, at, "UTC")).toBe(false); // exclusive upper bound
  });
});

describe("isRuleActiveAt — recurrence gate", () => {
  it("honours the weekday mask in the effective timezone", () => {
    const mondayOnly = mkRule({ recurrenceDays: MONDAY });
    expect(isRuleActiveAt(mondayOnly, new Date("2024-06-03T12:00:00Z"), "UTC")).toBe(true); // Mon
    expect(isRuleActiveAt(mondayOnly, new Date("2024-06-04T12:00:00Z"), "UTC")).toBe(false); // Tue
  });

  it("weekday is read in the user's zone, not UTC", () => {
    // 2024-06-04T02:00Z is Tuesday UTC but still Monday in Los Angeles (UTC-7).
    const mondayOnly = mkRule({ recurrenceDays: MONDAY });
    const instant = new Date("2024-06-04T02:00:00Z");
    expect(isRuleActiveAt(mondayOnly, instant, "UTC")).toBe(false);
    expect(isRuleActiveAt(mondayOnly, instant, "America/Los_Angeles")).toBe(true);
  });

  it("honours the half-open intra-day window [start, end)", () => {
    // Active 16:00–18:00 local (960..1080).
    const window = mkRule({ recurrenceStartMinute: 960, recurrenceEndMinute: 1080 });
    expect(isRuleActiveAt(window, new Date("2024-06-03T15:59:00Z"), "UTC")).toBe(false);
    expect(isRuleActiveAt(window, new Date("2024-06-03T16:00:00Z"), "UTC")).toBe(true);
    expect(isRuleActiveAt(window, new Date("2024-06-03T17:59:00Z"), "UTC")).toBe(true);
    expect(isRuleActiveAt(window, new Date("2024-06-03T18:00:00Z"), "UTC")).toBe(false);
  });

  it("requires both weekday and intra-day gates to pass when both are set", () => {
    const rule = mkRule({
      recurrenceDays: MONDAY,
      recurrenceStartMinute: 960,
      recurrenceEndMinute: 1080,
    });
    // Monday but outside the window:
    expect(isRuleActiveAt(rule, new Date("2024-06-03T12:00:00Z"), "UTC")).toBe(false);
    // Inside the window but a Tuesday:
    expect(isRuleActiveAt(rule, new Date("2024-06-04T17:00:00Z"), "UTC")).toBe(false);
    // Monday and inside the window:
    expect(isRuleActiveAt(rule, new Date("2024-06-03T17:00:00Z"), "UTC")).toBe(true);
  });
});

describe("ruleActiveAt — composes with schedule-precedence", () => {
  it("resolves the winning action for an instant via first-match-wins", () => {
    const rules: ScheduleRule[] = [
      mkRule({
        id: 1,
        ordinal: 0,
        action: "deny",
        recurrenceStartMinute: 960,
        recurrenceEndMinute: 1080,
      }),
      mkRule({ id: 2, ordinal: 1, action: "allow" }),
    ];
    const inWindow = ruleActiveAt(new Date("2024-06-03T17:00:00Z"), "UTC");
    const outOfWindow = ruleActiveAt(new Date("2024-06-03T12:00:00Z"), "UTC");
    expect(resolveEffectiveAction(rules, inWindow, "allow")).toBe("deny");
    expect(resolveEffectiveAction(rules, outOfWindow, "allow")).toBe("allow");
  });
});

describe("effectivePolicy — allowed windows", () => {
  it("defaults to allow all day with no schedule rules", () => {
    const result = effectivePolicy(mkInput());
    expect(result.allowedWindows).toEqual([{ start: 0, end: 1440 }]);
    expect(result.date).toBe("2024-06-03");
    expect(result.tz).toBe("UTC");
    expect(result.activeRules).toEqual([]);
  });

  it("carves deny windows out of the baseline-allow day", () => {
    const result = effectivePolicy(
      mkInput({
        schedules: [
          mkRule({ action: "deny", recurrenceStartMinute: 480, recurrenceEndMinute: 1080 }),
        ],
      }),
    );
    expect(result.allowedWindows).toEqual([
      { start: 0, end: 480 },
      { start: 1080, end: 1440 },
    ]);
  });

  it("first-match-wins: an earlier allow pre-empts a later deny", () => {
    const result = effectivePolicy(
      mkInput({
        schedules: [
          mkRule({ id: 1, ordinal: 0, action: "allow" }),
          mkRule({
            id: 2,
            ordinal: 1,
            action: "deny",
            recurrenceStartMinute: 480,
            recurrenceEndMinute: 1080,
          }),
        ],
      }),
    );
    expect(result.allowedWindows).toEqual([{ start: 0, end: 1440 }]);
  });

  it("first-match-wins: an earlier deny pre-empts a later allow → no access", () => {
    const result = effectivePolicy(
      mkInput({
        schedules: [
          mkRule({ id: 1, ordinal: 0, action: "deny" }),
          mkRule({
            id: 2,
            ordinal: 1,
            action: "allow",
            recurrenceStartMinute: 480,
            recurrenceEndMinute: 1080,
          }),
        ],
      }),
    );
    expect(result.allowedWindows).toEqual([]);
  });

  it("treats `extend` as permitting access and respects its precedence", () => {
    const result = effectivePolicy(
      mkInput({
        schedules: [
          mkRule({
            id: 1,
            ordinal: 0,
            action: "extend",
            recurrenceStartMinute: 600,
            recurrenceEndMinute: 720,
          }),
          mkRule({
            id: 2,
            ordinal: 1,
            action: "deny",
            recurrenceStartMinute: 480,
            recurrenceEndMinute: 1080,
          }),
        ],
      }),
    );
    expect(result.allowedWindows).toEqual([
      { start: 0, end: 480 },
      { start: 600, end: 720 },
      { start: 1080, end: 1440 },
    ]);
  });

  it("ignores a rule whose weekday mask excludes the resolved day", () => {
    // A Monday-only deny has no effect on a Tuesday (2024-06-04).
    const result = effectivePolicy(
      mkInput({
        date: { year: 2024, month: 6, day: 4 },
        schedules: [mkRule({ action: "deny", recurrenceDays: MONDAY })],
      }),
    );
    expect(result.allowedWindows).toEqual([{ start: 0, end: 1440 }]);
    expect(result.activeRules).toEqual([]);
  });

  it("applies a rule whose weekday mask includes the resolved day", () => {
    const result = effectivePolicy(
      mkInput({
        schedules: [
          mkRule({
            action: "deny",
            recurrenceDays: EVERY_DAY,
            recurrenceStartMinute: 0,
            recurrenceEndMinute: 60,
          }),
        ],
      }),
    );
    expect(result.allowedWindows).toEqual([{ start: 60, end: 1440 }]);
  });

  it("date-gates a rule whose effective window does not overlap the day", () => {
    const result = effectivePolicy(
      mkInput({
        schedules: [mkRule({ action: "deny", effectiveFrom: new Date("2024-07-01T00:00:00Z") })],
      }),
    );
    expect(result.allowedWindows).toEqual([{ start: 0, end: 1440 }]);
  });
});

describe("effectivePolicy — activeRules", () => {
  it("lists every candidate rule (all scopes) in precedence order", () => {
    const result = effectivePolicy(
      mkInput({
        schedules: [
          mkRule({ id: 5, ordinal: 1, targetKind: "activity", targetId: 9, action: "deny" }),
          mkRule({
            id: 3,
            ordinal: 0,
            action: "allow",
            recurrenceStartMinute: 480,
            recurrenceEndMinute: 1080,
          }),
        ],
      }),
    );
    expect(result.activeRules).toEqual([
      {
        id: 3,
        targetKind: "overall",
        targetId: null,
        action: "allow",
        startMinute: 480,
        endMinute: 1080,
      },
      {
        id: 5,
        targetKind: "activity",
        targetId: 9,
        action: "deny",
        startMinute: 0,
        endMinute: 1440,
      },
    ]);
    // The activity-scoped rule does not shape the overall allowed windows.
    expect(result.allowedWindows).toEqual([{ start: 0, end: 1440 }]);
  });
});

describe("effectivePolicy — overall budget", () => {
  const dailyOverall: BudgetInput = {
    scope: "overall",
    targetId: null,
    window: "daily",
    secondsAllowed: 7200,
  };

  it("is null with no daily overall budget", () => {
    const weekly: BudgetInput = {
      scope: "overall",
      targetId: null,
      window: "weekly",
      secondsAllowed: 36000,
    };
    expect(effectivePolicy(mkInput({ budgets: [weekly] })).overallSeconds).toBeNull();
  });

  it("is the daily baseline when no grants apply", () => {
    expect(effectivePolicy(mkInput({ budgets: [dailyOverall] })).overallSeconds).toBe(7200);
  });

  it("adds an active overall grant that overlaps the day", () => {
    const grant: GrantInput = {
      scope: "overall",
      targetId: null,
      secondsGranted: 1800,
      grantedAt: new Date("2024-06-01T00:00:00Z"),
      expiresAt: new Date("2024-06-04T00:00:00Z"),
      revokedAt: null,
    };
    expect(
      effectivePolicy(mkInput({ budgets: [dailyOverall], grants: [grant] })).overallSeconds,
    ).toBe(9000);
  });

  it("ignores revoked and non-overlapping grants", () => {
    const revoked: GrantInput = {
      scope: "overall",
      targetId: null,
      secondsGranted: 1800,
      grantedAt: new Date("2024-06-01T00:00:00Z"),
      expiresAt: new Date("2024-06-04T00:00:00Z"),
      revokedAt: new Date("2024-06-02T00:00:00Z"),
    };
    const expiredAtDayStart: GrantInput = {
      ...revoked,
      revokedAt: null,
      expiresAt: new Date("2024-06-03T00:00:00Z"), // == dayStart, exclusive → no overlap
    };
    const grantedAtDayEnd: GrantInput = {
      ...revoked,
      revokedAt: null,
      grantedAt: new Date("2024-06-04T00:00:00Z"), // == dayEnd, exclusive → no overlap
      expiresAt: new Date("2024-06-10T00:00:00Z"),
    };
    const result = effectivePolicy(
      mkInput({ budgets: [dailyOverall], grants: [revoked, expiredAtDayStart, grantedAtDayEnd] }),
    );
    expect(result.overallSeconds).toBe(7200);
  });
});

describe("effectivePolicy — per-activity quotas", () => {
  it("composes daily activity/group budgets with active grants, ascending by target", () => {
    const budgets: BudgetInput[] = [
      { scope: "activity", targetId: 2, window: "daily", secondsAllowed: 3600 },
      { scope: "group", targetId: 1, window: "daily", secondsAllowed: 1800 },
      { scope: "activity", targetId: 5, window: "weekly", secondsAllowed: 9999 }, // weekly → ignored
    ];
    const grants: GrantInput[] = [
      {
        scope: "activity",
        targetId: 2,
        secondsGranted: 600,
        grantedAt: new Date("2024-06-01T00:00:00Z"),
        expiresAt: new Date("2024-06-04T00:00:00Z"),
        revokedAt: null,
      },
      {
        // Grant on a target with no daily budget → base is unlimited → skipped.
        scope: "activity",
        targetId: 99,
        secondsGranted: 600,
        grantedAt: new Date("2024-06-01T00:00:00Z"),
        expiresAt: new Date("2024-06-04T00:00:00Z"),
        revokedAt: null,
      },
    ];
    const result = effectivePolicy(mkInput({ budgets, grants }));
    expect(result.perActivitySeconds).toEqual([
      { scope: "activity", targetId: 2, seconds: 4200 },
      { scope: "group", targetId: 1, seconds: 1800 },
    ]);
  });
});

describe("effectivePolicy — timezone & formatting", () => {
  it("resolves the day in the user's zone and zero-pads the date", () => {
    const result = effectivePolicy(
      mkInput({ date: { year: 2024, month: 1, day: 5 }, tz: "America/New_York" }),
    );
    expect(result.date).toBe("2024-01-05");
    expect(result.tz).toBe("America/New_York");
  });
});
