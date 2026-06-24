/**
 * Shared schedule-precedence helper.
 *
 * Covers first-match-wins resolution (`docs/adr/0004-schedule-precedence.md`),
 * the stored-ordinal ordering and dense reordering the editor persists, and
 * the conservative shadow detector behind the editor's "this rule will never
 * apply" warning.
 */
import { describe, expect, it } from "vitest";

import type { Scope, ScheduleAction } from "../../src/policy/enums.js";
import {
  byOrdinal,
  effectiveRuleIds,
  findShadowedRules,
  nextOrdinal,
  reorder,
  ReorderMismatchError,
  resolveEffectiveAction,
  resolveEffectiveRule,
  type ScheduleRule,
} from "../../src/policy/schedule-precedence.js";

/**
 * Two provably-distinct recurrence windows (ADR 0005) — the shadow heuristic
 * compares the reserved recurrence fields field-for-field, so these stand in
 * for the old free-text `cron_or_window` strings (one reused = "identical
 * window", two different = "different windows").
 */
const WEEKDAY_AFTERNOON = {
  recurrenceDays: 0b0011111, // Mon–Fri
  recurrenceStartMinute: 960, // 16:00
  recurrenceEndMinute: 1080, // 18:00
  effectiveFrom: null,
  effectiveTo: null,
} satisfies Partial<ScheduleRule>;
const WEEKEND_MORNING = {
  recurrenceDays: 0b1100000, // Sat–Sun
  recurrenceStartMinute: 480, // 08:00
  recurrenceEndMinute: 720, // 12:00
  effectiveFrom: null,
  effectiveTo: null,
} satisfies Partial<ScheduleRule>;

/** Build a rule with sensible defaults so each test states only what it cares about. */
function rule(overrides: Partial<ScheduleRule> & Pick<ScheduleRule, "id">): ScheduleRule {
  return {
    ordinal: 0,
    targetKind: "overall" as Scope,
    targetId: null,
    // The always-on degenerate (every recurrence field null), so window-agnostic
    // tests need not restate it; the shadow-heuristic cases set a window below.
    recurrenceDays: null,
    recurrenceStartMinute: null,
    recurrenceEndMinute: null,
    effectiveFrom: null,
    effectiveTo: null,
    action: "allow" as ScheduleAction,
    ...overrides,
  };
}

/** Predicate helper: active iff the rule's id is in the given set. */
const activeIds =
  (...ids: number[]) =>
  (r: ScheduleRule): boolean =>
    ids.includes(r.id);

describe("byOrdinal", () => {
  it("sorts ascending by ordinal", () => {
    const sorted = byOrdinal([
      rule({ id: 1, ordinal: 2 }),
      rule({ id: 2, ordinal: 0 }),
      rule({ id: 3, ordinal: 1 }),
    ]);
    expect(sorted.map((r) => r.id)).toStrictEqual([2, 3, 1]);
  });

  it("breaks ordinal ties by ascending id, deterministically", () => {
    const sorted = byOrdinal([rule({ id: 9, ordinal: 5 }), rule({ id: 4, ordinal: 5 })]);
    expect(sorted.map((r) => r.id)).toStrictEqual([4, 9]);
  });

  it("does not mutate the input array", () => {
    const input = [rule({ id: 1, ordinal: 2 }), rule({ id: 2, ordinal: 1 })];
    const before = input.map((r) => r.id);
    byOrdinal(input);
    expect(input.map((r) => r.id)).toStrictEqual(before);
  });
});

describe("resolveEffectiveRule (first match wins)", () => {
  it("returns the lowest-ordinal active rule, regardless of input order", () => {
    const rules = [
      rule({ id: 1, ordinal: 2, action: "allow" }),
      rule({ id: 2, ordinal: 0, action: "deny" }),
      rule({ id: 3, ordinal: 1, action: "extend" }),
    ];
    // All active: ordinal 0 (id 2) wins.
    expect(resolveEffectiveRule(rules, () => true)?.id).toBe(2);
  });

  it("skips inactive higher-precedence rules and falls through to the next active one", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, action: "deny" }),
      rule({ id: 2, ordinal: 1, action: "allow" }),
    ];
    // The top rule's window is not active right now, so the next one wins.
    expect(resolveEffectiveRule(rules, activeIds(2))?.id).toBe(2);
  });

  it("returns undefined when no rule is active", () => {
    const rules = [rule({ id: 1, ordinal: 0 }), rule({ id: 2, ordinal: 1 })];
    expect(resolveEffectiveRule(rules, () => false)).toBeUndefined();
  });

  it("returns undefined for an empty rule set", () => {
    expect(resolveEffectiveRule([], () => true)).toBeUndefined();
  });
});

describe("resolveEffectiveAction", () => {
  it("yields the winning rule's action", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, action: "deny" }),
      rule({ id: 2, ordinal: 1, action: "allow" }),
    ];
    expect(resolveEffectiveAction(rules, () => true, "allow")).toBe("deny");
  });

  it("yields the fallback when no rule is active", () => {
    const rules = [rule({ id: 1, ordinal: 0, action: "deny" })];
    expect(resolveEffectiveAction(rules, () => false, "allow")).toBe("allow");
  });

  it("yields the fallback for an empty rule set", () => {
    expect(resolveEffectiveAction([], () => true, "deny")).toBe("deny");
  });
});

describe("nextOrdinal", () => {
  it("is 0 for an empty set", () => {
    expect(nextOrdinal([])).toBe(0);
  });

  it("is one past the current maximum ordinal", () => {
    expect(
      nextOrdinal([
        rule({ id: 1, ordinal: 0 }),
        rule({ id: 2, ordinal: 4 }),
        rule({ id: 3, ordinal: 2 }),
      ]),
    ).toBe(5);
  });
});

describe("reorder", () => {
  it("reassigns dense 0..n-1 ordinals to match the new id order", () => {
    const rules = [
      rule({ id: 10, ordinal: 0 }),
      rule({ id: 20, ordinal: 1 }),
      rule({ id: 30, ordinal: 2 }),
    ];
    const reordered = reorder(rules, [30, 10, 20]);
    expect(reordered.map((r) => [r.id, r.ordinal])).toStrictEqual([
      [30, 0],
      [10, 1],
      [20, 2],
    ]);
  });

  it("preserves every non-ordinal field of each rule", () => {
    const rules = [rule({ id: 1, ordinal: 0, action: "deny", ...WEEKDAY_AFTERNOON })];
    const [moved] = reorder(rules, [1]);
    expect(moved).toMatchObject({
      id: 1,
      action: "deny",
      recurrenceDays: WEEKDAY_AFTERNOON.recurrenceDays,
      recurrenceStartMinute: WEEKDAY_AFTERNOON.recurrenceStartMinute,
      recurrenceEndMinute: WEEKDAY_AFTERNOON.recurrenceEndMinute,
      ordinal: 0,
    });
  });

  it("does not mutate the input rules", () => {
    const rules = [rule({ id: 1, ordinal: 0 }), rule({ id: 2, ordinal: 1 })];
    reorder(rules, [2, 1]);
    expect(rules.map((r) => r.ordinal)).toStrictEqual([0, 1]);
  });

  it("throws when the id count differs from the rule count", () => {
    const rules = [rule({ id: 1 }), rule({ id: 2 })];
    expect(() => reorder(rules, [1])).toThrow(ReorderMismatchError);
  });

  it("throws when an id is not among the rules", () => {
    const rules = [rule({ id: 1 }), rule({ id: 2 })];
    expect(() => reorder(rules, [1, 99])).toThrow(/not among the rules/);
  });

  it("throws when an id is repeated", () => {
    const rules = [rule({ id: 1 }), rule({ id: 2 })];
    expect(() => reorder(rules, [1, 1])).toThrow(/more than once/);
  });
});

describe("findShadowedRules", () => {
  it("flags a later rule with an identical window under an earlier overall rule", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", targetId: null, ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 7, ...WEEKDAY_AFTERNOON }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 2, shadowedById: 1 }]);
  });

  it("flags a later rule shadowed by an earlier identical-target, identical-window rule", () => {
    const rules = [
      rule({
        id: 1,
        ordinal: 0,
        targetKind: "activity",
        targetId: 7,
        ...WEEKDAY_AFTERNOON,
        action: "deny",
      }),
      rule({
        id: 2,
        ordinal: 1,
        targetKind: "activity",
        targetId: 7,
        ...WEEKDAY_AFTERNOON,
        action: "allow",
      }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 2, shadowedById: 1 }]);
  });

  it("flags two always-on degenerate rules with the same target (every field null)", () => {
    // The degenerate (all recurrence fields null) is a window like any other:
    // an earlier always-on rule shadows a later always-on rule on the same target.
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall" }),
      rule({ id: 2, ordinal: 1, targetKind: "overall" }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 2, shadowedById: 1 }]);
  });

  it("does not flag rules with different recurrence windows (conservative — no false positive)", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "overall", ...WEEKEND_MORNING }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("treats the effective date range as part of the window: equal instants shadow", () => {
    const from = new Date("2026-03-25T00:00:00Z");
    const to = new Date("2026-04-02T00:00:00Z");
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", effectiveFrom: from, effectiveTo: to }),
      rule({
        id: 2,
        ordinal: 1,
        targetKind: "overall",
        effectiveFrom: new Date(from),
        effectiveTo: new Date(to),
      }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 2, shadowedById: 1 }]);
  });

  it("does not flag rules whose effective ranges differ", () => {
    const rules = [
      rule({
        id: 1,
        ordinal: 0,
        targetKind: "overall",
        effectiveFrom: new Date("2026-03-25T00:00:00Z"),
      }),
      rule({
        id: 2,
        ordinal: 1,
        targetKind: "overall",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("does not flag when one rule date-scopes and the other is open-ended", () => {
    const rules = [
      rule({
        id: 1,
        ordinal: 0,
        targetKind: "overall",
        effectiveFrom: new Date("2026-03-25T00:00:00Z"),
      }),
      rule({ id: 2, ordinal: 1, targetKind: "overall", effectiveFrom: null }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("does not flag a later rule whose target the earlier rule does not cover", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "activity", targetId: 7, ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 8, ...WEEKDAY_AFTERNOON }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("treats targetKind as part of the match: same id, different kind is not shadowing", () => {
    // A group rule and an activity rule that happen to share a target_id are
    // different targets — the earlier one must not shadow the later.
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "group", targetId: 7, ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 7, ...WEEKDAY_AFTERNOON }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("does not treat a narrower earlier rule as shadowing a broader later rule", () => {
    // An activity rule cannot shadow a later overall rule: it does not cover
    // everything the overall rule does.
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "activity", targetId: 7, ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "overall", targetId: null, ...WEEKDAY_AFTERNOON }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("reports each shadowed rule once, against its highest-precedence shadower", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "overall", ...WEEKDAY_AFTERNOON }),
      rule({ id: 3, ordinal: 2, targetKind: "overall", ...WEEKDAY_AFTERNOON }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([
      { shadowedId: 2, shadowedById: 1 },
      { shadowedId: 3, shadowedById: 1 },
    ]);
  });

  it("evaluates shadowing in ordinal order, not input order", () => {
    // id 2 has the lower ordinal, so it is the shadower even though it is
    // listed second in the input.
    const rules = [
      rule({ id: 1, ordinal: 1, targetKind: "overall", ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 0, targetKind: "overall", ...WEEKDAY_AFTERNOON }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 1, shadowedById: 2 }]);
  });

  it("returns no findings for an empty or single-rule set", () => {
    expect(findShadowedRules([])).toStrictEqual([]);
    expect(findShadowedRules([rule({ id: 1 })])).toStrictEqual([]);
  });
});

describe("effectiveRuleIds", () => {
  /** Sort so set-membership assertions don't depend on insertion order. */
  const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

  it("picks the first active rule per distinct target", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "activity", targetId: 5, action: "deny" }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 6, action: "deny" }),
      rule({ id: 3, ordinal: 2, targetKind: "activity", targetId: 5, action: "allow" }),
    ];
    // Each target's first always-on rule wins; the later activity:5 rule does not.
    expect(sorted(effectiveRuleIds(rules, () => true))).toStrictEqual([1, 2]);
  });

  it("never reports a rule a broader overall rule shadows (consistent with findShadowedRules)", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", action: "allow" }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 5, action: "deny" }),
    ];
    // The overall rule covers the activity target too, so it wins everywhere.
    expect(effectiveRuleIds(rules, () => true)).toStrictEqual([1]);
    // And the activity rule is exactly the one findShadowedRules flags.
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 2, shadowedById: 1 }]);
  });

  it("skips a target whose covering rules are all inactive right now", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "activity", targetId: 5, ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 6 }), // always-on
    ];
    // Only id 2's window is active now → only it is in effect.
    expect(effectiveRuleIds(rules, activeIds(2))).toStrictEqual([2]);
  });

  it("falls through to a lower-precedence active rule when the first is inactive", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", ...WEEKDAY_AFTERNOON }),
      rule({ id: 2, ordinal: 1, targetKind: "overall" }), // always-on
    ];
    expect(effectiveRuleIds(rules, activeIds(2))).toStrictEqual([2]);
  });

  it("returns nothing for an empty rule set", () => {
    expect(effectiveRuleIds([], () => true)).toStrictEqual([]);
  });
});
