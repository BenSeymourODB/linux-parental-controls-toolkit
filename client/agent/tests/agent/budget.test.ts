import { describe, expect, it } from "vitest";

import {
  BudgetCache,
  budgetKey,
  OVERALL_BUDGET_KEY,
  remainingSeconds,
  type CachedBudget,
} from "../../src/agent/budget.js";

const overall: CachedBudget = {
  key: OVERALL_BUDGET_KEY,
  label: "overall screen time",
  activityId: null,
  totalSeconds: 3600,
};
const youtube: CachedBudget = {
  key: "activity:7",
  label: "YouTube",
  activityId: 7,
  totalSeconds: 1800,
};

describe("budgetKey", () => {
  it("maps null to the overall key and an id to activity:<id>", () => {
    expect(budgetKey(null)).toBe(OVERALL_BUDGET_KEY);
    expect(budgetKey(7)).toBe("activity:7");
  });
});

describe("remainingSeconds", () => {
  it("subtracts usage and clamps at zero", () => {
    expect(remainingSeconds(3600, 1200)).toBe(2400);
    expect(remainingSeconds(3600, 3600)).toBe(0);
    expect(remainingSeconds(3600, 5000)).toBe(0);
  });

  it("floors fractional inputs", () => {
    expect(remainingSeconds(100.9, 40.9)).toBe(60);
  });
});

describe("BudgetCache", () => {
  it("lists a copy of the seeded budgets in order", () => {
    const cache = new BudgetCache([overall, youtube]);
    expect(cache.list()).toEqual([overall, youtube]);
    // Mutating the returned copy must not affect the cache.
    const first = cache.list()[0];
    if (!first) throw new Error("expected a seeded budget");
    first.totalSeconds = 0;
    expect(cache.get(OVERALL_BUDGET_KEY)?.totalSeconds).toBe(3600);
  });

  it("replace swaps the whole set", () => {
    const cache = new BudgetCache([overall]);
    cache.replace([youtube]);
    expect(cache.list()).toEqual([youtube]);
    expect(cache.get(OVERALL_BUDGET_KEY)).toBeUndefined();
  });

  it("applyGrant adds seconds to the overall budget", () => {
    const cache = new BudgetCache([overall]);
    const updated = cache.applyGrant(null, 900);
    expect(updated?.totalSeconds).toBe(4500);
    expect(cache.get(OVERALL_BUDGET_KEY)?.totalSeconds).toBe(4500);
  });

  it("applyGrant adds seconds to the targeted activity budget", () => {
    const cache = new BudgetCache([overall, youtube]);
    expect(cache.applyGrant(7, 300)?.totalSeconds).toBe(2100);
    // The overall budget is untouched.
    expect(cache.get(OVERALL_BUDGET_KEY)?.totalSeconds).toBe(3600);
  });

  it("applyGrant returns null for an unknown budget", () => {
    const cache = new BudgetCache([overall]);
    expect(cache.applyGrant(99, 300)).toBeNull();
  });

  it("ignores a negative grant delta", () => {
    const cache = new BudgetCache([overall]);
    expect(cache.applyGrant(null, -100)?.totalSeconds).toBe(3600);
  });
});
