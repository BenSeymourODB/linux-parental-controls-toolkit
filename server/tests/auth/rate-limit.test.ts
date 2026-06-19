/**
 * Unit tests for the failed-login rate limiter (#52).
 */
import { describe, expect, it } from "vitest";

import { LoginRateLimiter } from "../../src/auth/rate-limit.js";

describe("LoginRateLimiter", () => {
  it("allows attempts under the limit and blocks once it is reached", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 1000, now: () => 0 });
    expect(limiter.isBlocked("ip")).toBe(false);
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(false);
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000, now: () => 0 });
    limiter.recordFailure("a");
    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(false);
  });

  it("resets after the window elapses", () => {
    let clock = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000, now: () => clock });
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
    clock = 1000; // window elapsed (>= windowMs)
    expect(limiter.isBlocked("ip")).toBe(false);
    // A failure after the window opens a fresh window rather than carrying over.
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
  });

  it("a success clears the recorded failures", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 1000, now: () => 0 });
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
    limiter.recordSuccess("ip");
    expect(limiter.isBlocked("ip")).toBe(false);
  });

  it("defaults to 5 attempts when no limit is given", () => {
    const limiter = new LoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 4; i += 1) limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(false);
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
  });
});
