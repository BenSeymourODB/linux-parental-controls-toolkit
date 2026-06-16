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
  findShadowedRules,
  nextOrdinal,
  reorder,
  ReorderMismatchError,
  resolveEffectiveAction,
  resolveEffectiveRule,
  type ScheduleRule,
} from "../../src/policy/schedule-precedence.js";

/** Build a rule with sensible defaults so each test states only what it cares about. */
function rule(overrides: Partial<ScheduleRule> & Pick<ScheduleRule, "id">): ScheduleRule {
  return {
    ordinal: 0,
    targetKind: "overall" as Scope,
    targetId: null,
    cronOrWindow: "* * * * *",
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
    const rules = [rule({ id: 1, ordinal: 0, action: "deny", cronOrWindow: "@daily" })];
    const [moved] = reorder(rules, [1]);
    expect(moved).toMatchObject({ id: 1, action: "deny", cronOrWindow: "@daily", ordinal: 0 });
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
      rule({ id: 1, ordinal: 0, targetKind: "overall", targetId: null, cronOrWindow: "@daily" }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 7, cronOrWindow: "@daily" }),
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
        cronOrWindow: "@daily",
        action: "deny",
      }),
      rule({
        id: 2,
        ordinal: 1,
        targetKind: "activity",
        targetId: 7,
        cronOrWindow: "@daily",
        action: "allow",
      }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 2, shadowedById: 1 }]);
  });

  it("does not flag rules with different windows (conservative — no false positive)", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", cronOrWindow: "@daily" }),
      rule({ id: 2, ordinal: 1, targetKind: "overall", cronOrWindow: "@weekly" }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("does not flag a later rule whose target the earlier rule does not cover", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "activity", targetId: 7, cronOrWindow: "@daily" }),
      rule({ id: 2, ordinal: 1, targetKind: "activity", targetId: 8, cronOrWindow: "@daily" }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("does not treat a narrower earlier rule as shadowing a broader later rule", () => {
    // An activity rule cannot shadow a later overall rule: it does not cover
    // everything the overall rule does.
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "activity", targetId: 7, cronOrWindow: "@daily" }),
      rule({ id: 2, ordinal: 1, targetKind: "overall", targetId: null, cronOrWindow: "@daily" }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([]);
  });

  it("reports each shadowed rule once, against its highest-precedence shadower", () => {
    const rules = [
      rule({ id: 1, ordinal: 0, targetKind: "overall", cronOrWindow: "@daily" }),
      rule({ id: 2, ordinal: 1, targetKind: "overall", cronOrWindow: "@daily" }),
      rule({ id: 3, ordinal: 2, targetKind: "overall", cronOrWindow: "@daily" }),
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
      rule({ id: 1, ordinal: 1, targetKind: "overall", cronOrWindow: "@daily" }),
      rule({ id: 2, ordinal: 0, targetKind: "overall", cronOrWindow: "@daily" }),
    ];
    expect(findShadowedRules(rules)).toStrictEqual([{ shadowedId: 1, shadowedById: 2 }]);
  });

  it("returns no findings for an empty or single-rule set", () => {
    expect(findShadowedRules([])).toStrictEqual([]);
    expect(findShadowedRules([rule({ id: 1 })])).toStrictEqual([]);
  });
});
