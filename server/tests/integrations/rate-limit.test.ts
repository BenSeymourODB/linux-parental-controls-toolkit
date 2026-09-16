/**
 * Unit tests for the inbound-integration request-count limiter (#115).
 *
 * The window behaviour is driven by an injected clock so no real time passes:
 * a fill-to-limit, the first over-limit request, per-key isolation, the window
 * reset once it elapses, and the reported metadata (limit / remaining / reset).
 */
import { describe, expect, it } from "vitest";

import { FixedWindowQuota } from "../../src/integrations/rate-limit.js";

/** A hand-cranked clock: `tick(ms)` advances it; `read` is the seam callback. */
function fakeClock(startMs = 1_000): { read: () => number; tick: (ms: number) => void } {
  let nowMs = startMs;
  return {
    read: () => nowMs,
    tick: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("FixedWindowQuota", () => {
  it("admits requests up to the limit, then limits further ones in the window", () => {
    const clock = fakeClock();
    const quota = new FixedWindowQuota({ maxRequests: 3, windowMs: 60_000, now: clock.read });

    const first = quota.consume("token-1");
    expect(first).toEqual({ limited: false, limit: 3, remaining: 2, resetSeconds: 60 });
    expect(quota.consume("token-1").remaining).toBe(1);

    const third = quota.consume("token-1");
    expect(third).toMatchObject({ limited: false, remaining: 0 });

    const fourth = quota.consume("token-1");
    expect(fourth).toMatchObject({ limited: true, limit: 3, remaining: 0 });
    // Reset is still reported so the caller can send Retry-After.
    expect(fourth.resetSeconds).toBeGreaterThan(0);
  });

  it("keeps each key's budget independent", () => {
    const clock = fakeClock();
    const quota = new FixedWindowQuota({ maxRequests: 1, windowMs: 60_000, now: clock.read });

    expect(quota.consume("a").limited).toBe(false);
    expect(quota.consume("a").limited).toBe(true);
    // A different token still has its full budget.
    expect(quota.consume("b").limited).toBe(false);
  });

  it("resets the count once the window elapses", () => {
    const clock = fakeClock();
    const quota = new FixedWindowQuota({ maxRequests: 2, windowMs: 60_000, now: clock.read });

    expect(quota.consume("t").limited).toBe(false);
    expect(quota.consume("t").limited).toBe(false);
    expect(quota.consume("t").limited).toBe(true);

    // Just before the boundary the window is still live → still limited.
    clock.tick(59_999);
    expect(quota.consume("t").limited).toBe(true);

    // At the boundary the window has elapsed → a fresh budget.
    clock.tick(1);
    const afterReset = quota.consume("t");
    expect(afterReset).toMatchObject({ limited: false, remaining: 1 });
  });

  it("reports whole seconds remaining until the window resets", () => {
    const clock = fakeClock();
    const quota = new FixedWindowQuota({ maxRequests: 5, windowMs: 30_000, now: clock.read });

    expect(quota.consume("t").resetSeconds).toBe(30);
    clock.tick(10_500);
    // 19.5 s left → rounded up to 20.
    expect(quota.consume("t").resetSeconds).toBe(20);
  });

  it("holds the counter bounded during a sustained over-limit flood", () => {
    const clock = fakeClock();
    const quota = new FixedWindowQuota({ maxRequests: 1, windowMs: 60_000, now: clock.read });

    quota.consume("t"); // allowed
    for (let i = 0; i < 1_000; i += 1) {
      expect(quota.consume("t").limited).toBe(true);
    }
    // Once the window elapses the key recovers cleanly (no leaked over-count).
    clock.tick(60_000);
    expect(quota.consume("t")).toMatchObject({ limited: false, remaining: 0 });
  });

  it("rejects a non-positive limit or window at construction", () => {
    expect(() => new FixedWindowQuota({ maxRequests: 0, windowMs: 1_000 })).toThrow(RangeError);
    expect(() => new FixedWindowQuota({ maxRequests: 5, windowMs: 0 })).toThrow(RangeError);
  });
});
