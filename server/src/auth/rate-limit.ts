/**
 * A minimal in-memory rate limiter for failed logins (#52).
 *
 * Scope-appropriate for a single-admin homelab dashboard: a fixed-window count
 * of *failed* attempts per key (client IP), held in process memory. It is not a
 * distributed limiter and does not need to be — there is one admin and one
 * process. A successful login clears the key; the window otherwise resets once
 * it elapses. The clock is injectable so the behaviour is testable without
 * real time.
 *
 * Deliberately not a dependency: `@fastify/rate-limit` targets per-route
 * request-rate limiting across a cluster, which is far more than the
 * "basic login rate-limiting" this issue calls for.
 */

/** A failed-attempt window for one key. */
interface Window {
  count: number;
  /** Epoch ms when the current window started. */
  startedAt: number;
}

/** Options for {@link LoginRateLimiter}. */
export interface LoginRateLimiterOptions {
  /** Failed attempts allowed within a window before the key is blocked. */
  maxAttempts?: number;
  /** Window length in milliseconds. */
  windowMs?: number;
  /** Clock seam for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Fixed-window failed-login limiter keyed by an arbitrary string (e.g. IP). */
export class LoginRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Return the live window for `key`, dropping it first if it has elapsed. */
  private current(key: string): Window | undefined {
    const window = this.windows.get(key);
    if (window === undefined) return undefined;
    if (this.now() - window.startedAt >= this.windowMs) {
      this.windows.delete(key);
      return undefined;
    }
    return window;
  }

  /** True when `key` has reached the failure limit within the current window. */
  isBlocked(key: string): boolean {
    const window = this.current(key);
    return window !== undefined && window.count >= this.maxAttempts;
  }

  /** Record a failed attempt for `key`, opening a new window if none is live. */
  recordFailure(key: string): void {
    const window = this.current(key);
    if (window === undefined) {
      this.windows.set(key, { count: 1, startedAt: this.now() });
    } else {
      window.count += 1;
    }
  }

  /** Clear any recorded failures for `key` (called on a successful login). */
  recordSuccess(key: string): void {
    this.windows.delete(key);
  }
}
