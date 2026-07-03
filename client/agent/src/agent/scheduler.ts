/**
 * The agent's timer seam (#103, Phase 8b).
 *
 * A minimal repeating-tick / one-shot-delay abstraction the agent's modules
 * (`force-close.ts`, `socket-client.ts`, `agent.ts`) drive their timers
 * through, so the countdown, the reconnect backoff, and the cadence tick loop
 * all unit-test deterministically with an injected fake — the same
 * inject-the-clock discipline the bridge uses in `ws-client.ts`. The concrete
 * {@link SystemScheduler} is the only place `node:timers` is touched.
 *
 * License boundary: none touched — `node:timers` globals only.
 */

/** An opaque cancellable timer handle from a {@link Scheduler}. */
export interface TimerHandle {
  readonly token: unknown;
}

/** Timer seam: a repeating tick and a one-shot delay, injectable for tests. */
export interface Scheduler {
  interval(callback: () => void, ms: number): TimerHandle;
  timeout(callback: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

/** The default {@link Scheduler}, backed by `node:timers` (unref'd). */
export class SystemScheduler implements Scheduler {
  interval(callback: () => void, ms: number): TimerHandle {
    const token = setInterval(callback, ms);
    token.unref?.();
    return { token };
  }
  timeout(callback: () => void, ms: number): TimerHandle {
    const token = setTimeout(callback, ms);
    token.unref?.();
    return { token };
  }
  cancel(handle: TimerHandle): void {
    // `token` is opaque (a `NodeJS.Timeout`); both clears accept the same
    // object, so route it through both rather than tracking which kind it is.
    const token = handle.token as ReturnType<typeof setInterval>;
    clearInterval(token);
    clearTimeout(token);
  }
}
