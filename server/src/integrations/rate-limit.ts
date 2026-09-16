/**
 * A minimal in-memory fixed-window **request-count** limiter for the inbound
 * integration surface (#115).
 *
 * `/api/integrations/*` authenticates external systems by a per-integration
 * bearer token (#114). `docs/architecture.md` → "External integrations"
 * requires those tokens to be rate-limited so a noisy or misbehaving integrator
 * (a retry storm from the family-calendar rewards webhook, a runaway loop)
 * can't overwhelm the single-process dashboard. This is that limiter: a
 * fixed-window count of *every* authenticated request per key (the token id),
 * held in process memory.
 *
 * It is deliberately **not** the failed-attempt limiter in `auth/rate-limit.ts`
 * — that one counts *failures* and clears on success (login / enrol
 * throttling). Per-token API throttling is the opposite shape: every request
 * counts, and the window resets only by elapsing. Two small mechanisms with
 * clear, separate semantics beat one overloaded class, and neither needs a
 * dependency — the same reasoning `auth/rate-limit.ts` records for not reaching
 * for `@fastify/rate-limit` (there is one process, so a distributed limiter is
 * more than this surface calls for).
 *
 * The clock is injectable so the window behaviour is testable without real
 * time.
 *
 * License boundary: none touched — plain TypeScript + `node`'s own clock.
 */

/** The outcome of consuming one request slot for a key. */
export interface RateLimitDecision {
  /** True when this request is over the limit and should be rejected `429`. */
  readonly limited: boolean;
  /** The window's request ceiling (the `RateLimit-Limit` header value). */
  readonly limit: number;
  /** Requests still allowed in the current window (`RateLimit-Remaining`). */
  readonly remaining: number;
  /**
   * Whole seconds until the current window resets — the `RateLimit-Reset`
   * value, and the `Retry-After` value when {@link limited}. Never negative.
   */
  readonly resetSeconds: number;
}

/**
 * The narrow slice of the limiter the integration guard drives — one method, so
 * a test can inject a spy and the real {@link FixedWindowQuota} drops in unchanged.
 */
export interface IntegrationRateLimiter {
  /** Count one request against `key` and report the resulting decision. */
  consume(key: string): RateLimitDecision;
}

/** One fixed window for a single key. */
interface Window {
  /** Requests seen in this window (capped one past the limit; see `consume`). */
  count: number;
  /** Epoch ms when the window opened. */
  startedAt: number;
}

/** Options for {@link FixedWindowQuota}. */
export interface FixedWindowQuotaOptions {
  /** Requests allowed per key within a window before further ones are limited. */
  readonly maxRequests: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Fixed-window request-count limiter keyed by an arbitrary string (here, the
 * integration-token id). Each {@link consume} counts one request; a key is
 * limited once its window count exceeds {@link FixedWindowQuotaOptions.maxRequests}.
 * Elapsed windows are dropped lazily on access, so an idle key costs nothing.
 */
export class FixedWindowQuota implements IntegrationRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();

  constructor(options: FixedWindowQuotaOptions) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new RangeError("FixedWindowQuota maxRequests must be a positive integer");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError("FixedWindowQuota windowMs must be a positive integer");
    }
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /** Return the live window for `key`, dropping it first if it has elapsed. */
  private current(key: string, at: number): Window | undefined {
    const window = this.windows.get(key);
    if (window === undefined) return undefined;
    if (at - window.startedAt >= this.windowMs) {
      this.windows.delete(key);
      return undefined;
    }
    return window;
  }

  /**
   * Count one request against `key` and report the decision. The counter is
   * capped one past the limit so a sustained flood within a window can't grow
   * it without bound — the extra requests are all uniformly `limited`, which is
   * all the caller needs.
   */
  consume(key: string): RateLimitDecision {
    const at = this.now();
    let window = this.current(key, at);
    if (window === undefined) {
      window = { count: 0, startedAt: at };
      this.windows.set(key, window);
    }
    // Only increment while at or below the ceiling; once over, hold the count so
    // a long flood in one window stays bounded.
    if (window.count <= this.maxRequests) {
      window.count += 1;
    }
    const count = window.count;
    const limited = count > this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - count);
    const resetSeconds = Math.max(0, Math.ceil((window.startedAt + this.windowMs - at) / 1000));
    return { limited, limit: this.maxRequests, remaining, resetSeconds };
  }
}
