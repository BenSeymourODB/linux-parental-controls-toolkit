import { describe, expect, it } from "vitest";

import type { NotificationHandle, Notifier, ProcessSignaller } from "../../src/agent/effects.js";
import { ForceCloseController, type ForceCloseDeps } from "../../src/agent/force-close.js";
import type { Scheduler, TimerHandle } from "../../src/agent/scheduler.js";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeNotifier implements Notifier {
  notified: { title: string; body: string }[] = [];
  updated: { title: string; body: string }[] = [];
  #next = 1;
  notify(o: { title: string; body: string }): Promise<NotificationHandle> {
    this.notified.push({ title: o.title, body: o.body });
    return Promise.resolve({ id: this.#next++ });
  }
  update(_h: NotificationHandle, o: { title: string; body: string }): Promise<NotificationHandle> {
    this.updated.push({ title: o.title, body: o.body });
    return Promise.resolve({ id: this.#next++ });
  }
}

class FakeSignaller implements ProcessSignaller {
  sent: { pid: number; signal: string }[] = [];
  signal(pid: number, signal: NodeJS.Signals): boolean {
    this.sent.push({ pid, signal });
    return true;
  }
}

class FakeScheduler implements Scheduler {
  intervals = new Map<TimerHandle, () => void>();
  timeouts = new Map<TimerHandle, () => void>();
  interval(callback: () => void): TimerHandle {
    const handle = { token: Symbol("interval") };
    this.intervals.set(handle, callback);
    return handle;
  }
  timeout(callback: () => void): TimerHandle {
    const handle = { token: Symbol("timeout") };
    this.timeouts.set(handle, callback);
    return handle;
  }
  cancel(handle: TimerHandle): void {
    this.intervals.delete(handle);
    this.timeouts.delete(handle);
  }
  /** Invoke the single live interval callback (the running countdown). */
  tick(): void {
    for (const cb of this.intervals.values()) cb();
  }
  /** Fire and clear all pending one-shot timeouts (the SIGKILL escalation). */
  fireTimeouts(): void {
    const cbs = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const cb of cbs) cb();
  }
}

function build(overrides: Partial<ForceCloseDeps> = {}): {
  controller: ForceCloseController;
  notifier: FakeNotifier;
  signaller: FakeSignaller;
  scheduler: FakeScheduler;
} {
  const notifier = new FakeNotifier();
  const signaller = new FakeSignaller();
  const scheduler = new FakeScheduler();
  const deps: ForceCloseDeps = {
    notifier,
    signaller,
    scheduler,
    resolvePids: () => Promise.resolve([111, 222]),
    graceSeconds: 3,
    sigkillEscalationMs: 5_000,
    renderToasts: true,
    ...overrides,
  };
  return { controller: new ForceCloseController(deps), notifier, signaller, scheduler };
}

describe("ForceCloseController.begin (local grace path)", () => {
  it("counts down, updating the toast each second, then SIGTERM→SIGKILL", async () => {
    const { controller, notifier, signaller, scheduler } = build();
    await controller.begin({ activityId: 7, label: "YouTube" });

    // Immediate "time's up" toast with the 3-second countdown.
    expect(notifier.notified).toHaveLength(1);
    expect(notifier.notified[0]?.body).toContain("closing in 3 seconds");
    expect(controller.isCountingDown(7)).toBe(true);

    scheduler.tick(); // 3 → 2
    scheduler.tick(); // 2 → 1
    await flush();
    expect(notifier.updated.at(-1)?.body).toContain("closing in 1 second");

    scheduler.tick(); // 1 → 0 → forceClose
    await flush();
    expect(signaller.sent).toEqual([
      { pid: 111, signal: "SIGTERM" },
      { pid: 222, signal: "SIGTERM" },
    ]);

    scheduler.fireTimeouts(); // escalation
    expect(signaller.sent.filter((s) => s.signal === "SIGKILL").map((s) => s.pid)).toEqual([
      111, 222,
    ]);
    expect(controller.isCountingDown(7)).toBe(false);
  });

  it("force-closes immediately when the grace period is zero", async () => {
    const { controller, notifier, signaller } = build({ graceSeconds: 0 });
    await controller.begin({ activityId: 7, label: "YouTube" });
    expect(notifier.notified[0]?.body).toContain("closing now");
    expect(signaller.sent.map((s) => s.signal)).toEqual(["SIGTERM", "SIGTERM"]);
  });

  it("ignores a repeat begin for an already-counting activity", async () => {
    const { controller, notifier } = build();
    await controller.begin({ activityId: 7, label: "YouTube" });
    await controller.begin({ activityId: 7, label: "YouTube" });
    expect(notifier.notified).toHaveLength(1);
  });
});

describe("ForceCloseController.forceCloseNow (server path — grace already elapsed)", () => {
  it("kills immediately with no fresh countdown even when graceSeconds > 0", async () => {
    const { controller, notifier, signaller, scheduler } = build({ graceSeconds: 15 });
    await controller.forceCloseNow({ activityId: 7, label: "YouTube" });
    // No 1 Hz countdown interval was started.
    expect(scheduler.intervals.size).toBe(0);
    expect(notifier.notified[0]?.body).toContain("closing now");
    expect(signaller.sent.map((s) => s.signal)).toEqual(["SIGTERM", "SIGTERM"]);
  });
});

describe("ForceCloseController grant-cancel", () => {
  it("cancels the countdown on a grant top-up and does not kill", async () => {
    const { controller, notifier, signaller, scheduler } = build();
    await controller.begin({ activityId: 7, label: "YouTube" });
    await controller.cancel(7, "Mum granted +30 minutes — keep going");

    expect(controller.isCountingDown(7)).toBe(false);
    expect(notifier.updated.at(-1)).toMatchObject({ title: "More time!" });
    scheduler.tick(); // the interval was cancelled; nothing happens
    await flush();
    expect(signaller.sent).toHaveLength(0);
  });

  it("a grant during the SIGTERM→SIGKILL window cancels the pending SIGKILL", async () => {
    const { controller, signaller, scheduler } = build({ graceSeconds: 0 });
    await controller.forceCloseNow({ activityId: 7, label: "YouTube" });
    // SIGTERM sent, escalation scheduled but not yet fired.
    expect(signaller.sent.map((s) => s.signal)).toEqual(["SIGTERM", "SIGTERM"]);
    await controller.cancel(7, "granted — keep going");
    scheduler.fireTimeouts(); // the escalation must have been cancelled
    expect(signaller.sent.some((s) => s.signal === "SIGKILL")).toBe(false);
  });

  it("cancel is a no-op for an unknown activity", async () => {
    const { controller, notifier } = build();
    await controller.cancel(999, "nope");
    expect(notifier.updated).toHaveLength(0);
  });
});

describe("ForceCloseController misc", () => {
  it("skips the kill (degraded) when no PIDs resolve", async () => {
    const { controller, signaller } = build({
      graceSeconds: 0,
      resolvePids: () => Promise.resolve([]),
    });
    await controller.begin({ activityId: 7, label: "YouTube" });
    expect(signaller.sent).toHaveLength(0);
    expect(controller.isCountingDown(7)).toBe(false);
  });

  it("suppresses toasts and sound when renderToasts is false, but still kills", async () => {
    const { controller, notifier, signaller } = build({ graceSeconds: 0, renderToasts: false });
    await controller.begin({ activityId: 7, label: "YouTube" });
    expect(notifier.notified).toHaveLength(0);
    expect(signaller.sent.map((s) => s.signal)).toEqual(["SIGTERM", "SIGTERM"]);
  });

  it("stop clears all in-flight countdowns and escalations", async () => {
    const { controller, signaller, scheduler } = build({ graceSeconds: 0 });
    await controller.forceCloseNow({ activityId: 7, label: "A" });
    controller.stop();
    expect(controller.isCountingDown(7)).toBe(false);
    scheduler.fireTimeouts(); // escalation was cancelled by stop()
    expect(signaller.sent.some((s) => s.signal === "SIGKILL")).toBe(false);
  });
});
