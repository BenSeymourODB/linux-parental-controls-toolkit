import { describe, expect, it } from "vitest";

import { SystemScheduler } from "../../src/agent/scheduler.js";

describe("SystemScheduler", () => {
  it("fires a real timeout and lets cancel prevent it", async () => {
    const scheduler = new SystemScheduler();
    let fired = false;
    await new Promise<void>((resolve) => scheduler.timeout(() => resolve(), 1));
    const cancelled = scheduler.timeout(() => (fired = true), 10);
    scheduler.cancel(cancelled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toBe(false);
  });

  it("fires a real interval that cancel stops", async () => {
    const scheduler = new SystemScheduler();
    let ticks = 0;
    const handle = scheduler.interval(() => (ticks += 1), 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    scheduler.cancel(handle);
    const seen = ticks;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(seen).toBeGreaterThan(0);
    expect(ticks).toBe(seen);
  });
});
