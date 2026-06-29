/**
 * Reconnect backoff for the bridge's outbound WebSocket (#101, Phase 8b).
 *
 * `docs/client-notifications.md`: the bridge "Reconnects with exponential
 * backoff on disconnect." This is the pure delay calculator behind that — no
 * timers, no sockets — so the schedule is unit-testable with an injected RNG
 * (`policy/schedule-precedence.ts` isolates a pure decision the same way on the
 * server). {@link WsClient} drives the actual `setTimeout`.
 *
 * The delay is `min(base * 2^attempt, max)`, then **full jitter** in
 * `[0, capped]` (AWS "Exponential Backoff And Jitter") so a fleet of clients
 * that all dropped on the same server restart do not reconnect in a synchronised
 * thundering herd. `attempt` is 0-based: attempt 0 is the first retry after the
 * first failure.
 *
 * License boundary: none touched — plain TypeScript.
 */

/** Tunable bounds for {@link computeBackoffDelayMs}. */
export interface BackoffOptions {
  /** Delay for attempt 0 before jitter, in ms. Must be > 0. */
  baseMs: number;
  /** Upper bound on the delay before jitter, in ms. Must be >= baseMs. */
  maxMs: number;
}

/** Default backoff: 1s base, capped at 60s — a long-lived connection can wait. */
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 60_000 };

/**
 * Full-jitter exponential backoff delay for a 0-based `attempt`.
 *
 * `rng` returns a float in `[0, 1)` (defaults to `Math.random`); inject a
 * deterministic one in tests. The exponential term is computed so that a large
 * `attempt` saturates at `maxMs` without overflowing to `Infinity`.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  // Saturate the exponent before the shift so 2 ** big stays finite, then cap.
  const exponential =
    safeAttempt >= 31 ? options.maxMs : Math.min(options.maxMs, options.baseMs * 2 ** safeAttempt);
  const capped = Math.max(options.baseMs, Math.min(options.maxMs, exponential));
  // Full jitter: a uniform draw in [0, capped]. Floor to whole ms for setTimeout.
  return Math.floor(rng() * capped);
}
