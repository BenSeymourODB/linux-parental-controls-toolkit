import { describe, expect, it } from "vitest";

import {
  CadenceTracker,
  coalesceWarnings,
  formatCadenceMessage,
  warningThresholdsSeconds,
  type CadenceWarning,
} from "../../src/agent/cadence.js";

const MIN = 60;

describe("warningThresholdsSeconds", () => {
  it("emits 15-minute multiples, 10, and 5..1 minutes, all below the total", () => {
    // A 60-minute budget: 45/30/15 (multiples of 15, < 60), 10, 5/4/3/2/1.
    expect(warningThresholdsSeconds(60 * MIN)).toEqual(
      [45, 30, 15, 10, 5, 4, 3, 2, 1].map((m) => m * MIN),
    );
  });

  it("drops boundaries at or above the total so a fresh budget is silent", () => {
    // Exactly 15 minutes: 15 == total is excluded, so it starts warning at 10.
    expect(warningThresholdsSeconds(15 * MIN)).toEqual([10, 5, 4, 3, 2, 1].map((m) => m * MIN));
    // 20 minutes: only the 15-minute boundary from the coarse tier.
    expect(warningThresholdsSeconds(20 * MIN)).toEqual([15, 10, 5, 4, 3, 2, 1].map((m) => m * MIN));
  });

  it("has no boundaries for a budget of a minute or less", () => {
    expect(warningThresholdsSeconds(MIN)).toEqual([]);
    expect(warningThresholdsSeconds(30)).toEqual([]);
    expect(warningThresholdsSeconds(0)).toEqual([]);
  });
});

describe("CadenceTracker", () => {
  it("warns once per boundary as a 20-minute budget drains, then times up", () => {
    const t = new CadenceTracker("overall", "overall screen time", 20 * MIN);
    // Above the first boundary: silence.
    expect(t.observe(20 * MIN)).toBeNull();
    expect(t.observe(16 * MIN)).toBeNull();

    const fired: number[] = [];
    for (let s = 15 * MIN; s >= 0; s -= 30) {
      const w = t.observe(s);
      if (w) fired.push(w.thresholdSeconds);
    }
    // 15, 10, 5, 4, 3, 2, 1 minute boundaries, then the 0 "times up".
    expect(fired).toEqual([15, 10, 5, 4, 3, 2, 1, 0].map((m) => (m === 0 ? 0 : m * MIN)));
  });

  it("does not re-announce a boundary already crossed", () => {
    const t = new CadenceTracker("a", "A", 20 * MIN);
    expect(t.observe(15 * MIN)?.thresholdSeconds).toBe(15 * MIN);
    // Hovering just under 15 must not re-fire the 15-minute warning.
    expect(t.observe(15 * MIN - 1)).toBeNull();
    expect(t.observe(11 * MIN)).toBeNull();
    // The 10-minute boundary is the next to fire.
    expect(t.observe(10 * MIN)?.thresholdSeconds).toBe(10 * MIN);
  });

  it("announces the deepest boundary reached on a large jump", () => {
    const t = new CadenceTracker("a", "A", 60 * MIN);
    // First reading is already at 3m20s: announce the deepest reached (4 min),
    // not the stale 15/10/5 boundaries above it.
    const w = t.observe(200);
    expect(w?.kind).toBe("warning");
    expect(w?.thresholdSeconds).toBe(4 * MIN);
    // Then it continues from there.
    expect(t.observe(3 * MIN)?.thresholdSeconds).toBe(3 * MIN);
  });

  it("fires timesUp exactly once and clamps negative remaining to zero", () => {
    const t = new CadenceTracker("a", "A", 5 * MIN);
    const first = t.observe(0);
    expect(first?.kind).toBe("timesUp");
    expect(first?.remainingSeconds).toBe(0);
    expect(t.observe(-10)).toBeNull();
    expect(t.observe(0)).toBeNull();
  });

  it("only ever times up for a sub-minute budget (no boundaries)", () => {
    const t = new CadenceTracker("a", "A", 40);
    expect(t.observe(40)).toBeNull();
    expect(t.observe(1)).toBeNull();
    expect(t.observe(0)?.kind).toBe("timesUp");
  });

  it("carries the budget identity into the warning", () => {
    const t = new CadenceTracker("activity:7", "YouTube", 6 * MIN);
    const w = t.observe(5 * MIN);
    expect(w).toMatchObject({ budgetKey: "activity:7", budgetLabel: "YouTube" });
  });
});

describe("coalesceWarnings / formatCadenceMessage", () => {
  const warn = (key: string, label: string, thresholdSeconds: number): CadenceWarning => ({
    budgetKey: key,
    budgetLabel: label,
    kind: "warning",
    remainingSeconds: thresholdSeconds,
    thresholdSeconds,
  });

  it("groups budgets crossing the same boundary into one toast", () => {
    const groups = coalesceWarnings([
      warn("activity:7", "YouTube", 5 * MIN),
      warn("activity:9", "Discord", 5 * MIN),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.budgets.map((b) => b.label)).toEqual(["YouTube", "Discord"]);
    expect(groups[0]?.message).toBe("YouTube and Discord have 5 minutes left.");
  });

  it("keeps distinct boundaries and kinds separate", () => {
    const groups = coalesceWarnings([
      warn("a", "A", 5 * MIN),
      warn("b", "B", 1 * MIN),
      { ...warn("c", "C", 0), kind: "timesUp", thresholdSeconds: 0 },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["warning", "warning", "timesUp"]);
  });

  it("formats singular minute, plurals, and the times-up message", () => {
    expect(
      formatCadenceMessage({ kind: "warning", thresholdSeconds: MIN, budgets: [{ label: "A" }] }),
    ).toBe("A has 1 minute left.");
    expect(
      formatCadenceMessage({
        kind: "warning",
        thresholdSeconds: 3 * MIN,
        budgets: [{ label: "A" }, { label: "B" }, { label: "C" }],
      }),
    ).toBe("A, B and C have 3 minutes left.");
    expect(
      formatCadenceMessage({ kind: "timesUp", thresholdSeconds: 0, budgets: [{ label: "A" }] }),
    ).toBe("Time's up — save and quit! A is out of time.");
    expect(
      formatCadenceMessage({
        kind: "timesUp",
        thresholdSeconds: 0,
        budgets: [{ label: "A" }, { label: "B" }],
      }),
    ).toBe("Time's up — save and quit! A and B are out of time.");
  });

  it("returns no groups for an empty tick", () => {
    expect(coalesceWarnings([])).toEqual([]);
  });
});
