/**
 * Small concurrency primitives shared across transports and services.
 *
 * `mapWithConcurrency` bounds how many async workers run at once over a list —
 * the Phase-5 telemetry pull (#86) and the client health probe (#198) both
 * fan out per-client work that must not stampede the SSH facade. `timerDeadline`
 * is an injectable per-operation deadline used to keep one wedged peer from
 * stalling a whole batch.
 *
 * License boundary: none touched — pure TypeScript, no I/O, no external linkage.
 */

/**
 * Run `worker` over `items` with at most `limit` in flight, returning the
 * results **in input order** (`results[i]` is `worker(items[i], i)`).
 *
 * Single-threaded JS makes the shared-cursor increments safe; the *completion*
 * order of the workers is not guaranteed, but the returned array is always
 * aligned to the input so callers can rely on positional ordering. `limit` is
 * floored and clamped to at least 1.
 *
 * An element that is literally `undefined` is skipped (no `worker` call, its
 * result slot left empty) — `noUncheckedIndexedAccess` can't prove an in-bounds
 * index is populated, and the callers here only ever map arrays of objects.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runnerCount = Math.min(Math.max(Math.floor(limit), 1), items.length);
  const runners: Promise<void>[] = [];
  for (let i = 0; i < runnerCount; i += 1) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          const item = items[index];
          if (item !== undefined) results[index] = await worker(item, index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * A one-shot deadline: `reached` resolves when the deadline elapses, and
 * `cancel()` releases the underlying timer when the work finishes first. Race a
 * unit of work against `reached` to bound how long the caller waits on it.
 */
export interface Deadline {
  /** Resolves once, when the deadline elapses. */
  readonly reached: Promise<void>;
  /** Release the underlying timer (idempotent). Call when work wins the race. */
  cancel(): void;
}

/** Builds a {@link Deadline}; injectable so callers can fake the clock in tests. */
export type DeadlineFactory = (ms: number) => Deadline;

/**
 * Default {@link DeadlineFactory} backed by `setTimeout`. The timer is `unref`'d
 * so a pending deadline never keeps the Node process alive on its own.
 */
export const timerDeadline: DeadlineFactory = (ms: number): Deadline => {
  let resolve!: () => void;
  const reached = new Promise<void>((r) => {
    resolve = r;
  });
  const handle = setTimeout(resolve, ms);
  // A bare deadline timer shouldn't hold the event loop open by itself.
  handle.unref?.();
  return {
    reached,
    cancel: () => clearTimeout(handle),
  };
};
