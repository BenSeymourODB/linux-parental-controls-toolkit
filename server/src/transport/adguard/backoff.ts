/**
 * Restart backoff for the managed AdGuard Home supervisor (#96, #310).
 *
 * Owns the "how often may we restart, and how long do we wait" policy that used
 * to live inline in `AdGuardManagedSupervisor.#onExit`: a consecutive-restart
 * counter, a stable-run reset (a single crash after a long healthy run is not
 * held against the cap), a hard cap, and an exponential delay with a ceiling.
 *
 * Pure and time-injected — the caller passes a monotonic-enough "now" (ms), so
 * this is unit-testable without real timers or a clock.
 */

/** Tuning for {@link RestartBackoff} (the supervisor's restart knobs). */
export interface RestartBackoffOptions {
  /** Max consecutive restarts before {@link RestartBackoff.nextDelayMs} gives up. */
  readonly maxRestarts: number;
  /** Uptime (ms) after which a run counts as "stable" and the counter resets. */
  readonly stableMs: number;
  /** Base delay (ms) between restarts; doubles per attempt. */
  readonly baseMs: number;
  /** Delay ceiling (ms). */
  readonly maxMs: number;
}

/**
 * Tracks consecutive restart attempts and computes the next backoff delay.
 *
 * Usage mirrors the supervisor's lifecycle:
 * - {@link markStarted} when a child is spawned (records the start time so the
 *   next exit can tell whether the run was stable).
 * - {@link nextDelayMs} after an *unexpected* exit: returns the delay to wait
 *   before the next restart, or `null` once the restart cap is exceeded.
 */
export class RestartBackoff {
  readonly #options: RestartBackoffOptions;
  #count = 0;
  #startedAt: number | null = null;

  constructor(options: RestartBackoffOptions) {
    this.#options = options;
  }

  /** Consecutive restarts recorded so far (surfaced as `status.restarts`). */
  get count(): number {
    return this.#count;
  }

  /** Record the moment the current child started, for the stable-run reset. */
  markStarted(nowMs: number): void {
    this.#startedAt = nowMs;
  }

  /**
   * Decide what to do after an unexpected child exit.
   *
   * First applies the stable-run reset: if the child ran for at least
   * `stableMs`, the consecutive-restart counter is cleared so a lone crash after
   * days of uptime does not count against the cap. Then either returns the next
   * backoff delay (ms) — bumping the attempt counter — or `null` when the cap
   * (`maxRestarts`) has been reached, meaning the caller should give up.
   */
  nextDelayMs(nowMs: number): number | null {
    if (this.#startedAt !== null && nowMs - this.#startedAt >= this.#options.stableMs) {
      this.#count = 0;
    }
    if (this.#count >= this.#options.maxRestarts) {
      return null;
    }
    this.#count += 1;
    return Math.min(this.#options.baseMs * 2 ** (this.#count - 1), this.#options.maxMs);
  }
}
