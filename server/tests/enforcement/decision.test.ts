/**
 * Unit tests for the pure per-activity enforcement decision core (#98).
 *
 * Covers: the exhaustion predicate (incl. the `0/0` idle guard), overage +
 * grace pass-through, cool-down suppression and its exact boundary, the
 * drop-under-quota cool-down reset, carry-forward of untouched cool-down
 * entries, group-scope decisions, and stable ordering.
 */
import { describe, expect, it } from "vitest";

import {
  decideEnforcement,
  targetKey,
  type QuotaConsumption,
} from "../../src/enforcement/decision.js";

const NOW = new Date("2026-06-19T12:00:00.000Z");

/** A quota fixture, defaulting to activity scope. */
function quota(
  partial: Partial<QuotaConsumption> & Pick<QuotaConsumption, "targetId">,
): QuotaConsumption {
  return {
    scope: partial.scope ?? "activity",
    targetId: partial.targetId,
    allowedSeconds: partial.allowedSeconds ?? 100,
    consumedSeconds: partial.consumedSeconds ?? 0,
  };
}

describe("targetKey", () => {
  it("namespaces by scope so an activity and a group with the same id don't collide", () => {
    expect(targetKey("activity", 7)).toBe("activity:7");
    expect(targetKey("group", 7)).toBe("group:7");
    expect(targetKey("activity", 7)).not.toBe(targetKey("group", 7));
  });
});

describe("decideEnforcement", () => {
  it("does not fire while consumption is under the allowance", () => {
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 50 })],
      lastFiredAt: new Map(),
    });
    expect(out.decisions).toHaveLength(0);
    expect(out.lastFiredAt.size).toBe(0);
  });

  it("fires exactly at the limit, carrying overage 0 and the grace period through", () => {
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 90,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 100 })],
      lastFiredAt: new Map(),
    });
    expect(out.decisions).toEqual([
      {
        scope: "activity",
        targetId: 1,
        allowedSeconds: 100,
        consumedSeconds: 100,
        overageSeconds: 0,
        graceSeconds: 90,
      },
    ]);
    expect(out.lastFiredAt.get("activity:1")).toEqual(NOW);
  });

  it("reports the overage when consumption exceeds the allowance", () => {
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 2, allowedSeconds: 100, consumedSeconds: 150 })],
      lastFiredAt: new Map(),
    });
    expect(out.decisions[0]?.overageSeconds).toBe(50);
  });

  it("does not fire a zero allowance with no usage, but does once usage appears", () => {
    const idle = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 3, allowedSeconds: 0, consumedSeconds: 0 })],
      lastFiredAt: new Map(),
    });
    expect(idle.decisions).toHaveLength(0);

    const used = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 3, allowedSeconds: 0, consumedSeconds: 5 })],
      lastFiredAt: new Map(),
    });
    expect(used.decisions).toHaveLength(1);
    expect(used.decisions[0]?.overageSeconds).toBe(5);
  });

  it("suppresses a re-fire inside the cool-down window and keeps the original timestamp", () => {
    const firedAt = new Date(NOW.getTime() - 200_000); // 200s ago, cooldown 300s
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 150 })],
      lastFiredAt: new Map([["activity:1", firedAt]]),
    });
    expect(out.decisions).toHaveLength(0);
    expect(out.lastFiredAt.get("activity:1")).toEqual(firedAt);
  });

  it("re-fires once the cool-down has elapsed (>= boundary) and re-stamps now", () => {
    const firedAt = new Date(NOW.getTime() - 300_000); // exactly cooldown ago
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 150 })],
      lastFiredAt: new Map([["activity:1", firedAt]]),
    });
    expect(out.decisions).toHaveLength(1);
    expect(out.lastFiredAt.get("activity:1")).toEqual(NOW);
  });

  it("clears the cool-down entry once a target drops back under quota", () => {
    const firedAt = new Date(NOW.getTime() - 10_000);
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 40 })],
      lastFiredAt: new Map([["activity:1", firedAt]]),
    });
    expect(out.decisions).toHaveLength(0);
    expect(out.lastFiredAt.has("activity:1")).toBe(false);
  });

  it("carries forward cool-down entries for targets absent from this evaluation", () => {
    const other = new Date(NOW.getTime() - 10_000);
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 50 })],
      lastFiredAt: new Map([["activity:99", other]]),
    });
    expect(out.lastFiredAt.get("activity:99")).toEqual(other);
  });

  it("fires group-scope targets and orders decisions by (scope, targetId)", () => {
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [
        quota({ scope: "group", targetId: 1, allowedSeconds: 100, consumedSeconds: 120 }),
        quota({ scope: "activity", targetId: 2, allowedSeconds: 100, consumedSeconds: 120 }),
        quota({ scope: "activity", targetId: 1, allowedSeconds: 100, consumedSeconds: 120 }),
      ],
      lastFiredAt: new Map(),
    });
    expect(out.decisions.map((d) => `${d.scope}:${d.targetId}`)).toEqual([
      "activity:1",
      "activity:2",
      "group:1",
    ]);
  });

  it("re-fires every evaluation when cool-down is disabled (cooldownSeconds = 0)", () => {
    // Fired one tick ago; with no cool-down window the target fires again now.
    const firedAt = new Date(NOW.getTime() - 1);
    const out = decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 0,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 150 })],
      lastFiredAt: new Map([["activity:1", firedAt]]),
    });
    expect(out.decisions).toHaveLength(1);
    expect(out.lastFiredAt.get("activity:1")).toEqual(NOW);
  });

  it("does not mutate the caller's lastFiredAt map", () => {
    const input = new Map<string, Date>();
    decideEnforcement({
      now: NOW,
      graceSeconds: 60,
      cooldownSeconds: 300,
      quotas: [quota({ targetId: 1, allowedSeconds: 100, consumedSeconds: 150 })],
      lastFiredAt: input,
    });
    expect(input.size).toBe(0);
  });
});
