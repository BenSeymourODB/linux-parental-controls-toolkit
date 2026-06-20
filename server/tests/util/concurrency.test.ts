/**
 * Unit tests for the shared concurrency primitives (#198): the order-preserving
 * `mapWithConcurrency` and the injectable `timerDeadline`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { mapWithConcurrency, timerDeadline } from "../../src/util/concurrency.js";

/** A controllable async worker: resolves each call when the test says so. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    // Item 0 resolves last, item 2 first — the result array must still be ordered.
    const delays = [30, 10, 0];
    const results = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${index}:${ms}`;
    });
    expect(results).toEqual(["0:30", "1:10", "2:0"]);
  });

  it("never runs more than `limit` workers at once", async () => {
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    let inFlight = 0;
    let maxInFlight = 0;

    const all = mapWithConcurrency(gates, 2, async (gate) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight -= 1;
      return inFlight;
    });

    // Once the first batch is running, only `limit` workers should be live.
    await Promise.resolve();
    expect(maxInFlight).toBe(2);
    // Release the first two; the runners then pick the remaining two off the
    // shared cursor — still never exceeding the limit.
    for (const gate of gates) gate.resolve(0);

    await all;
    expect(maxInFlight).toBe(2);
  });

  it("clamps a sub-1 limit to a single runner", async () => {
    const order: number[] = [];
    const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      order.push(n);
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6]);
    // limit 0 → 1 runner → strictly sequential.
    expect(order).toEqual([1, 2, 3]);
  });

  it("returns an empty array for empty input without invoking the worker", async () => {
    const worker = vi.fn();
    expect(await mapWithConcurrency([], 4, worker)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });
});

describe("timerDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves `reached` once the deadline elapses", async () => {
    vi.useFakeTimers();
    const deadline = timerDeadline(1000);
    let resolved = false;
    void deadline.reached.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("cancel() clears the timer so `reached` never resolves", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const deadline = timerDeadline(1000);
    let resolved = false;
    void deadline.reached.then(() => {
      resolved = true;
    });

    deadline.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(resolved).toBe(false);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
