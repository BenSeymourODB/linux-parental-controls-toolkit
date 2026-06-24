import { describe, expect, it } from "vitest";

import { computeBackoffDelayMs, DEFAULT_BACKOFF } from "../../src/bridge/backoff.js";

describe("computeBackoffDelayMs", () => {
  const opts = { baseMs: 1_000, maxMs: 60_000 };

  it("with rng=1 the un-jittered ceiling doubles per attempt up to maxMs", () => {
    // rng returns just under 1, so floor(rng*cap) reveals the cap for that attempt.
    const ceil = (attempt: number) => computeBackoffDelayMs(attempt, opts, () => 0.999999);
    expect(ceil(0)).toBe(999); // ~1s
    expect(ceil(1)).toBe(1999); // ~2s
    expect(ceil(2)).toBe(3999); // ~4s
    expect(ceil(3)).toBe(7999); // ~8s
    expect(ceil(6)).toBe(59999); // base*2^6 = 64s, capped to maxMs (60s)
  });

  it("saturates at maxMs for large and overflow-prone attempts", () => {
    expect(computeBackoffDelayMs(100, opts, () => 0)).toBe(0);
    expect(computeBackoffDelayMs(100, opts, () => 0.999999)).toBe(59999);
    // Beyond the exponent guard (attempt >= 31) the cap is maxMs, not Infinity.
    expect(computeBackoffDelayMs(1000, opts, () => 0.5)).toBe(30000);
  });

  it("applies full jitter: 0 with rng=0, never exceeds the cap", () => {
    expect(computeBackoffDelayMs(5, opts, () => 0)).toBe(0);
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = computeBackoffDelayMs(attempt, opts, () => 0.42);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(opts.maxMs);
    }
  });

  it("clamps negative/fractional attempts to a 0-based floor", () => {
    expect(computeBackoffDelayMs(-3, opts, () => 0.999999)).toBe(999);
    expect(computeBackoffDelayMs(2.9, opts, () => 0.999999)).toBe(3999);
  });

  it("defaults to DEFAULT_BACKOFF bounds", () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseMs: 1_000, maxMs: 60_000 });
    const d = computeBackoffDelayMs(0, undefined, () => 0.5);
    expect(d).toBe(500);
  });
});
