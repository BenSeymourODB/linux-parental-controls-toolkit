/**
 * Tests for the managed AdGuard Home restart backoff (#310).
 *
 * Pure arithmetic over an injected "now" — no timers, no clock. Mirrors the
 * restart policy `AdGuardManagedSupervisor` used to compute inline.
 */
import { describe, expect, it } from "vitest";

import { RestartBackoff } from "../../../src/transport/adguard/backoff.js";

const OPTS = { maxRestarts: 5, stableMs: 60_000, baseMs: 1_000, maxMs: 60_000 };

describe("RestartBackoff", () => {
  it("starts at zero restarts", () => {
    expect(new RestartBackoff(OPTS).count).toBe(0);
  });

  it("returns an exponentially doubling delay, bumping the count each attempt", () => {
    const backoff = new RestartBackoff(OPTS);
    backoff.markStarted(0);

    // Every exit looks instantaneous (now === startedAt) → never a stable reset.
    expect(backoff.nextDelayMs(0)).toBe(1_000); // base, attempt 1
    expect(backoff.count).toBe(1);
    expect(backoff.nextDelayMs(0)).toBe(2_000); // attempt 2
    expect(backoff.nextDelayMs(0)).toBe(4_000); // attempt 3
    expect(backoff.nextDelayMs(0)).toBe(8_000); // attempt 4
    expect(backoff.count).toBe(4);
  });

  it("caps the delay at maxMs", () => {
    const backoff = new RestartBackoff({ ...OPTS, maxRestarts: 100, maxMs: 5_000 });
    backoff.markStarted(0);
    const delays = Array.from({ length: 6 }, () => backoff.nextDelayMs(0));
    // 1000, 2000, 4000, then clamped to the 5000 ceiling.
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
  });

  it("returns null once the restart cap is reached", () => {
    const backoff = new RestartBackoff({ ...OPTS, maxRestarts: 2 });
    backoff.markStarted(0);
    expect(backoff.nextDelayMs(0)).toBe(1_000); // 1
    expect(backoff.nextDelayMs(0)).toBe(2_000); // 2
    expect(backoff.nextDelayMs(0)).toBeNull(); // cap exceeded → give up
    expect(backoff.count).toBe(2); // count not bumped past the cap
  });

  it("resets the counter after a stable run", () => {
    const backoff = new RestartBackoff({ ...OPTS, maxRestarts: 2, stableMs: 1_000 });

    // First crash is immediate (uptime 0 < stableMs) → count 1.
    backoff.markStarted(0);
    expect(backoff.nextDelayMs(0)).toBe(1_000);
    expect(backoff.count).toBe(1);

    // Next run is stable (5000 - 4000 >= stableMs) → reset to 0, then bump to 1.
    backoff.markStarted(4_000);
    expect(backoff.nextDelayMs(5_000)).toBe(1_000);
    expect(backoff.count).toBe(1);
  });

  it("does not reset when it has never been started", () => {
    const backoff = new RestartBackoff({ ...OPTS, stableMs: 0 });
    // startedAt is null → the stable-reset guard is skipped even with stableMs 0.
    expect(backoff.nextDelayMs(1_000)).toBe(1_000);
    expect(backoff.count).toBe(1);
  });

  it("gives up immediately when maxRestarts is zero", () => {
    const backoff = new RestartBackoff({ ...OPTS, maxRestarts: 0 });
    backoff.markStarted(0);
    expect(backoff.nextDelayMs(0)).toBeNull();
    expect(backoff.count).toBe(0);
  });
});
