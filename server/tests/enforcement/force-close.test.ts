/**
 * Tests for the force-close trigger orchestration (#99) with fully-faked seams
 * (no live SSH or WebSocket): the grace timer + de-dup, decision→client
 * fan-out, group expansion, the event-vs-pkill choice driven by the delivery
 * count, and the defensive handling of empty resolutions and a throwing
 * fallback.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnforcementDecision } from "../../src/enforcement/decision.js";
import {
  ForceCloseTrigger,
  type ForceCloseActivity,
  type ForceCloseClient,
  type ForceCloseDeps,
} from "../../src/enforcement/force-close.js";
import type { ServerEvent } from "../../src/events/taxonomy.js";
import type { SshTarget } from "../../src/transport/ssh/facade.js";

const TARGET: SshTarget = { host: "alice-pc", username: "pct-agent", privateKey: "k" };

function client(clientId: number, osUserRef = "1001"): ForceCloseClient {
  return { clientId, osUserRef, sshTarget: TARGET };
}

function decision(over: Partial<EnforcementDecision> = {}): EnforcementDecision {
  return {
    scope: "activity",
    targetId: 7,
    allowedSeconds: 3600,
    consumedSeconds: 3600,
    overageSeconds: 0,
    graceSeconds: 60,
    ...over,
  };
}

const firefox: ForceCloseActivity = { activityId: 7, matcher: "firefox", matchType: "exact" };

/** A deps double whose timer fires synchronously and whose seams are spies. */
function makeDeps(over: Partial<ForceCloseDeps> = {}): {
  deps: ForceCloseDeps;
  publishToClient: ReturnType<typeof vi.fn>;
  forceCloseOverSsh: ReturnType<typeof vi.fn>;
  recordEventAudit: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
} {
  const publishToClient = vi.fn<(clientId: number, event: ServerEvent) => number>(() => 1);
  const forceCloseOverSsh = vi.fn(async () => undefined);
  const recordEventAudit = vi.fn();
  // Default timer: invoke immediately so a single awaited tick drives dispatch.
  const schedule = vi.fn((cb: () => void) => {
    cb();
  });
  const deps: ForceCloseDeps = {
    publishToClient,
    clientsForUser: () => [client(1)],
    resolveActivities: () => [firefox],
    forceCloseOverSsh,
    recordEventAudit,
    schedule,
    logger: { warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, publishToClient, forceCloseOverSsh, recordEventAudit, schedule };
}

/** Let the fire-and-forget dispatch promise settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ForceCloseTrigger.enforce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules each decision after its own grace period", () => {
    const schedule = vi.fn();
    const { deps } = makeDeps({ schedule });
    const trigger = new ForceCloseTrigger(deps);
    trigger.enforce(1, [
      decision({ graceSeconds: 90 }),
      decision({ targetId: 8, graceSeconds: 30 }),
    ]);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[0]?.[1]).toBe(90_000);
    expect(schedule.mock.calls[1]?.[1]).toBe(30_000);
  });

  it("emits enforce.force_close when the bridge is reachable, and audits it", async () => {
    const { deps, publishToClient, recordEventAudit, forceCloseOverSsh } = makeDeps();
    new ForceCloseTrigger(deps).enforce(5, [decision()]);
    await flush();
    expect(publishToClient).toHaveBeenCalledWith(1, {
      type: "enforce.force_close",
      userId: 5,
      activityId: 7,
    });
    expect(recordEventAudit).toHaveBeenCalledWith({ client: client(1), userId: 5, activityId: 7 });
    expect(forceCloseOverSsh).not.toHaveBeenCalled();
  });

  it("falls back to pkill when delivery reaches no live socket", async () => {
    const { deps, recordEventAudit, forceCloseOverSsh } = makeDeps({
      publishToClient: vi.fn(() => 0),
    });
    new ForceCloseTrigger(deps).enforce(5, [decision()]);
    await flush();
    expect(forceCloseOverSsh).toHaveBeenCalledWith({
      client: client(1),
      activity: firefox,
      userId: 5,
    });
    expect(recordEventAudit).not.toHaveBeenCalled();
  });

  it("expands a group decision to every member activity", async () => {
    const chrome: ForceCloseActivity = { activityId: 8, matcher: "chrome", matchType: "exact" };
    const { deps, publishToClient } = makeDeps({ resolveActivities: () => [firefox, chrome] });
    new ForceCloseTrigger(deps).enforce(5, [decision({ scope: "group", targetId: 3 })]);
    await flush();
    expect(
      publishToClient.mock.calls.map(
        (c) => (c[1] as ServerEvent & { activityId: number }).activityId,
      ),
    ).toEqual([7, 8]);
  });

  it("chooses per-client: event for the live one, pkill for the offline one", async () => {
    const live = client(1);
    const offline = client(2, "2002");
    const publishToClient = vi.fn((id: number) => (id === 1 ? 1 : 0));
    const { deps, forceCloseOverSsh, recordEventAudit } = makeDeps({
      publishToClient,
      clientsForUser: () => [live, offline],
    });
    new ForceCloseTrigger(deps).enforce(5, [decision()]);
    await flush();
    expect(recordEventAudit).toHaveBeenCalledTimes(1);
    expect(recordEventAudit).toHaveBeenCalledWith({ client: live, userId: 5, activityId: 7 });
    expect(forceCloseOverSsh).toHaveBeenCalledTimes(1);
    expect(forceCloseOverSsh).toHaveBeenCalledWith({
      client: offline,
      activity: firefox,
      userId: 5,
    });
  });

  it("de-dups a target already pending grace", () => {
    const schedule = vi.fn();
    const { deps } = makeDeps({ schedule });
    const trigger = new ForceCloseTrigger(deps);
    trigger.enforce(5, [decision()]);
    trigger.enforce(5, [decision()]); // same (user, scope, target) — still pending
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("re-arms a target once its grace timer has fired", () => {
    let fire: (() => void) | undefined;
    const schedule = vi.fn((cb: () => void) => {
      fire = cb;
    });
    const { deps } = makeDeps({ schedule, publishToClient: vi.fn(() => 1) });
    const trigger = new ForceCloseTrigger(deps);
    trigger.enforce(5, [decision()]);
    fire?.(); // grace elapsed → dispatch + clears pending
    trigger.enforce(5, [decision()]);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("warns and does nothing when the decision resolves to no apps", async () => {
    const { deps, publishToClient, forceCloseOverSsh } = makeDeps({ resolveActivities: () => [] });
    new ForceCloseTrigger(deps).enforce(5, [decision()]);
    await flush();
    expect(publishToClient).not.toHaveBeenCalled();
    expect(forceCloseOverSsh).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("warns and does nothing when the user is on no clients", async () => {
    const { deps, publishToClient } = makeDeps({ clientsForUser: () => [] });
    new ForceCloseTrigger(deps).enforce(5, [decision()]);
    await flush();
    expect(publishToClient).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("logs and continues when the pkill fallback throws unexpectedly", async () => {
    const { deps } = makeDeps({
      publishToClient: vi.fn(() => 0),
      forceCloseOverSsh: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    new ForceCloseTrigger(deps).enforce(5, [decision()]);
    await flush();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("logs when dispatch itself throws (a deps read failed)", async () => {
    const { deps } = makeDeps({
      clientsForUser: () => {
        throw new Error("db down");
      },
    });
    new ForceCloseTrigger(deps).enforce(5, [decision()]);
    await flush();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5 }),
      "force_close dispatch failed",
    );
  });
});
