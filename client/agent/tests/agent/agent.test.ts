import { describe, expect, it } from "vitest";

import type { Logger } from "../../src/bridge/logger.js";
import type { EventFrame, ServerEvent } from "../../src/bridge/protocol.js";
import { Agent, type AgentOptions } from "../../src/agent/agent.js";
import { BudgetCache, type CachedBudget } from "../../src/agent/budget.js";
import { agentConfigSchema } from "../../src/agent/config.js";
import type {
  NotifyOptions,
  Notifier,
  NotificationHandle,
  SoundPlayer,
} from "../../src/agent/effects.js";
import type {
  ForceClose,
  ForceCloseTarget,
  Scheduler,
  TimerHandle,
} from "../../src/agent/force-close.js";
import type { SocketFactory, SocketLike } from "../../src/agent/socket-client.js";
import type { UsageSource } from "../../src/agent/usage.js";

const MIN = 60;
const noop = (): void => undefined;
const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeNotifier implements Notifier {
  calls: NotifyOptions[] = [];
  notify(o: NotifyOptions): Promise<NotificationHandle> {
    this.calls.push(o);
    return Promise.resolve({ id: 1 });
  }
  update(_h: NotificationHandle, o: NotifyOptions): Promise<NotificationHandle> {
    this.calls.push(o);
    return Promise.resolve({ id: 1 });
  }
}

class FakeSound implements SoundPlayer {
  played: (string | null)[] = [];
  play(soundName: string | null): Promise<void> {
    this.played.push(soundName);
    return Promise.resolve();
  }
}

class FakeForceClose implements ForceClose {
  begun: ForceCloseTarget[] = [];
  cancelled: { activityId: number; message: string }[] = [];
  stopped = 0;
  begin(target: ForceCloseTarget): Promise<void> {
    this.begun.push(target);
    return Promise.resolve();
  }
  cancel(activityId: number, message: string): Promise<void> {
    this.cancelled.push({ activityId, message });
    return Promise.resolve();
  }
  stop(): void {
    this.stopped += 1;
  }
}

class FakeUsage implements UsageSource {
  map = new Map<string, number>();
  usedSeconds(): Promise<Map<string, number>> {
    return Promise.resolve(new Map(this.map));
  }
}

class FakeScheduler implements Scheduler {
  intervals: (() => void)[] = [];
  cancelled = 0;
  interval(callback: () => void): TimerHandle {
    this.intervals.push(callback);
    return { token: Symbol() };
  }
  timeout(): TimerHandle {
    return { token: Symbol() };
  }
  cancel(): void {
    this.cancelled += 1;
  }
}

class FakeSocket implements SocketLike {
  #connect?: () => void;
  #data?: (chunk: Buffer) => void;
  destroyed = false;

  on(event: "connect" | "close", listener: () => void): this;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "connect" | "close" | "data" | "error",
    listener: (() => void) | ((chunk: Buffer) => void) | ((err: Error) => void),
  ): this {
    if (event === "connect") this.#connect = listener as () => void;
    else if (event === "data") this.#data = listener as (chunk: Buffer) => void;
    // close/error are unused in these orchestrator tests.
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
  emitConnect(): void {
    this.#connect?.();
  }
  emitData(chunk: Buffer): void {
    this.#data?.(chunk);
  }
}

interface Harness {
  agent: Agent;
  notifier: FakeNotifier;
  sound: FakeSound;
  forceClose: FakeForceClose;
  usage: FakeUsage;
  budgets: BudgetCache;
  scheduler: FakeScheduler;
  socketRef: { socket?: FakeSocket };
}

function build(
  budgets: CachedBudget[],
  prefs: { enabled?: boolean; soundProfile?: "off" | "subtle" | "prominent" } = {},
): Harness {
  const notifier = new FakeNotifier();
  const sound = new FakeSound();
  const forceClose = new FakeForceClose();
  const usage = new FakeUsage();
  const scheduler = new FakeScheduler();
  const cache = new BudgetCache(budgets);
  const socketRef: { socket?: FakeSocket } = {};
  const factory: SocketFactory = () => (socketRef.socket = new FakeSocket());
  const config = agentConfigSchema.parse({
    userId: 42,
    socketPath: "/run/pct/1001.sock",
    notifications: {
      enabled: prefs.enabled ?? true,
      soundProfile: prefs.soundProfile ?? "subtle",
      graceSeconds: 15,
      cadenceOverrides: null,
    },
  });
  const opts: AgentOptions = {
    config,
    budgets: cache,
    usage,
    notifier,
    soundPlayer: sound,
    forceClose,
    scheduler,
    logger: silentLogger,
    socketFactory: factory,
  };
  return {
    agent: new Agent(opts),
    notifier,
    sound,
    forceClose,
    usage,
    budgets: cache,
    scheduler,
    socketRef,
  };
}

const overall = (totalSeconds: number): CachedBudget => ({
  key: "overall",
  label: "overall screen time",
  activityId: null,
  totalSeconds,
});
const activity = (id: number, totalSeconds: number): CachedBudget => ({
  key: `activity:${id}`,
  label: "YouTube",
  activityId: id,
  totalSeconds,
});

const emit = async (h: Harness, event: ServerEvent): Promise<void> => {
  h.socketRef.socket?.emitConnect();
  const frame: EventFrame = { seq: 1, at: "2026-07-03T12:00:00.000Z", event };
  h.socketRef.socket?.emitData(Buffer.from(JSON.stringify(frame) + "\n"));
  await flush();
};

describe("Agent cadence tick loop", () => {
  it("renders coalesced warnings with the right urgency and sound", async () => {
    const h = build([overall(20 * MIN)]);
    h.usage.map.set("overall", 5 * MIN); // remaining 15 min
    await h.agent.tick();
    expect(h.notifier.calls[0]).toMatchObject({ title: "Time remaining", urgency: "normal" });
    expect(h.notifier.calls[0]?.body).toContain("15 minutes left");
    expect(h.sound.played).toEqual(["message-new-instant"]);

    h.usage.map.set("overall", 19 * MIN); // remaining 1 min → critical + final-warning sound
    await h.agent.tick();
    expect(h.notifier.calls.at(-1)).toMatchObject({ urgency: "critical" });
    expect(h.sound.played.at(-1)).toBe("dialog-warning");
  });

  it("times up the overall budget without a force-close", async () => {
    const h = build([overall(5 * MIN)]);
    h.usage.map.set("overall", 5 * MIN);
    await h.agent.tick();
    expect(h.notifier.calls.at(-1)).toMatchObject({ title: "Time's up" });
    expect(h.forceClose.begun).toHaveLength(0);
  });

  it("starts a local force-close when a per-app budget hits zero", async () => {
    const h = build([activity(7, 5 * MIN)]);
    h.usage.map.set("activity:7", 5 * MIN);
    await h.agent.tick();
    expect(h.forceClose.begun).toEqual([{ activityId: 7, label: "YouTube" }]);
  });

  it("still force-closes with notifications disabled, but shows no toast", async () => {
    const h = build([activity(7, 5 * MIN)], { enabled: false });
    h.usage.map.set("activity:7", 5 * MIN);
    await h.agent.tick();
    expect(h.notifier.calls).toHaveLength(0);
    expect(h.forceClose.begun).toHaveLength(1);
  });

  it("shows a toast but plays no sound when the profile is off", async () => {
    const h = build([overall(20 * MIN)], { soundProfile: "off" });
    h.usage.map.set("overall", 5 * MIN);
    await h.agent.tick();
    expect(h.notifier.calls).toHaveLength(1);
    expect(h.sound.played).toHaveLength(0);
  });

  it("treats a budget with no usage sample as full (silent)", async () => {
    const h = build([activity(7, 5 * MIN)]);
    await h.agent.tick(); // no usage entry → remaining full → no warning
    expect(h.notifier.calls).toHaveLength(0);
  });
});

describe("Agent event handling", () => {
  it("applies a grant: tops up the budget, toasts, plays the grant sound", async () => {
    const h = build([overall(20 * MIN)]);
    h.agent.start();
    await emit(h, {
      type: "grant.applied",
      userId: 42,
      grantedSeconds: 600,
      reason: "chores done",
      activityId: null,
    });
    expect(h.budgets.get("overall")?.totalSeconds).toBe(20 * MIN + 600);
    expect(h.notifier.calls.at(-1)).toMatchObject({ title: "More time!" });
    expect(h.notifier.calls.at(-1)?.body).toBe("+10 min granted · chores done");
    expect(h.sound.played.at(-1)).toBe("complete");
  });

  it("a per-app grant cancels that activity's in-flight countdown", async () => {
    const h = build([activity(7, 5 * MIN)]);
    h.agent.start();
    await emit(h, { type: "enforce.force_close", userId: 42, activityId: 7 });
    expect(h.forceClose.begun).toEqual([{ activityId: 7, label: "YouTube" }]);
    await emit(h, {
      type: "grant.applied",
      userId: 42,
      grantedSeconds: 300,
      reason: "bonus",
      activityId: 7,
    });
    expect(h.forceClose.cancelled[0]?.activityId).toBe(7);
  });

  it("force_close for an uncached activity still begins with a fallback label", async () => {
    const h = build([]);
    h.agent.start();
    await emit(h, { type: "enforce.force_close", userId: 42, activityId: 9 });
    expect(h.forceClose.begun).toEqual([{ activityId: 9, label: "This app" }]);
  });

  it("toasts a policy summary, a session lock, and a cleared lockout", async () => {
    const h = build([]);
    h.agent.start();
    await emit(h, { type: "policy.changed", userId: 42, summary: "YouTube is now 1h" });
    expect(h.notifier.calls.at(-1)).toMatchObject({
      title: "Limit updated",
      body: "YouTube is now 1h",
    });
    await emit(h, { type: "enforce.session_lock", userId: 42 });
    expect(h.notifier.calls.at(-1)).toMatchObject({ title: "Time's up", urgency: "critical" });
    await emit(h, { type: "lockout.cleared", userId: 42 });
    expect(h.notifier.calls.at(-1)).toMatchObject({ title: "More time!" });
  });

  it("logs (no throw) a grant for an uncached budget", async () => {
    const h = build([]);
    h.agent.start();
    await emit(h, {
      type: "grant.applied",
      userId: 42,
      grantedSeconds: 120,
      reason: "x",
      activityId: null,
    });
    // Toast still fires; no budget to top up.
    expect(h.notifier.calls.at(-1)?.title).toBe("More time!");
  });
});

describe("Agent lifecycle", () => {
  it("start wires the tick interval; stop cancels it and stops force-close", () => {
    const h = build([]);
    h.agent.start();
    expect(h.scheduler.intervals).toHaveLength(1);
    expect(h.socketRef.socket).toBeDefined();
    h.agent.stop();
    expect(h.scheduler.cancelled).toBeGreaterThanOrEqual(1);
    expect(h.forceClose.stopped).toBe(1);
    expect(h.socketRef.socket?.destroyed).toBe(true);
  });

  it("the interval callback runs a tick", async () => {
    const h = build([overall(20 * MIN)]);
    h.usage.map.set("overall", 5 * MIN);
    h.agent.start();
    h.scheduler.intervals[0]?.(); // fire the tick loop once
    await flush();
    expect(h.notifier.calls.at(-1)?.body).toContain("15 minutes left");
  });
});
