/**
 * Unit tests for the queued same-day-adjustment executor (#274): the
 * deferred-resolve (read → compute absolute target → persist → set), replay
 * idempotency, the clamp at zero, the `=` fast path (no read), rollover expiry,
 * and a non-retriable `--userinfo` parse failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClient, createUser } from "../../../src/policy/repository.js";
import { enqueue, listForClient } from "../../../src/transport/queue/repository.js";
import type { QueuedAction } from "../../../src/transport/queue/types.js";
import { createTimeTodayExecutor } from "../../../src/transport/time-today/executor.js";
import { queuedActionForOfflineAdjustment } from "../../../src/transport/time-today/queued.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const NOW = new Date("2026-06-23T12:00:00.000Z");

/** A recording fake client; `remaining` is the `TIME_LEFT_DAY` the read returns. */
function fakeClient(remaining: number | undefined) {
  const sets: { operation: string; seconds: number }[] = [];
  let reads = 0;
  return {
    sets,
    get reads(): number {
      return reads;
    },
    getUserInfo(): Promise<{ get(key: string): string | undefined }> {
      reads += 1;
      return Promise.resolve({
        get: (key: string): string | undefined =>
          key === "TIME_LEFT_DAY" && remaining !== undefined ? String(remaining) : undefined,
      });
    },
    setTimeLeft(operation: string, seconds: number): Promise<void> {
      sets.push({ operation, seconds });
      return Promise.resolve();
    },
  };
}

describe("createTimeTodayExecutor", () => {
  let db: TestDb;
  let clientId: number;
  let userId: number;

  beforeEach(() => {
    db = testDb();
    clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    userId = createUser(db, { displayName: "Alice" }).id; // tz null → defaultTz
  });
  afterEach(() => {
    db.$client.close();
  });

  /** Enqueue an offline adjustment and return the drained action (with its id). */
  function enqueueAction(operation: "+" | "-" | "=", seconds: number, targetDate = "2026-06-23") {
    enqueue(
      db,
      queuedActionForOfflineAdjustment({
        clientId,
        userId,
        osUsername: "alice",
        targetDate,
        operation,
        seconds,
      }),
    );
    return (): QueuedAction => {
      // Rebuild from the stored row each call, exactly as `drainClient` does, so
      // a replay sees any payload the previous run persisted.
      const [stored] = listForClient(db, clientId);
      if (stored === undefined) throw new Error("row vanished");
      return {
        id: stored.id,
        clientId: stored.clientId,
        coalesceKey: stored.coalesceKey,
        kind: stored.kind,
        payload: stored.payload,
      };
    };
  }

  it("defers a delta: reads remaining, sets the absolute target, persists it", async () => {
    const client = fakeClient(3600);
    const execute = createTimeTodayExecutor({
      db,
      defaultTz: "UTC",
      now: () => NOW,
      buildClient: () => client,
    });
    const action = enqueueAction("+", 1800);

    await execute(action());

    expect(client.reads).toBe(1);
    expect(client.sets).toEqual([{ operation: "=", seconds: 5400 }]); // 3600 + 1800
    const [stored] = listForClient(db, clientId);
    expect((stored?.payload as { resolvedTargetSeconds: number }).resolvedTargetSeconds).toBe(5400);
  });

  it("is idempotent on replay: re-uses the persisted target without re-reading", async () => {
    const client = fakeClient(3600);
    const execute = createTimeTodayExecutor({
      db,
      defaultTz: "UTC",
      now: () => NOW,
      buildClient: () => client,
    });
    const action = enqueueAction("+", 1800);

    await execute(action()); // resolves + persists 5400
    await execute(action()); // replay: must NOT read again, sets the same 5400

    expect(client.reads).toBe(1);
    expect(client.sets).toEqual([
      { operation: "=", seconds: 5400 },
      { operation: "=", seconds: 5400 },
    ]);
  });

  it("clamps a subtraction below zero to zero", async () => {
    const client = fakeClient(600);
    const execute = createTimeTodayExecutor({
      db,
      defaultTz: "UTC",
      now: () => NOW,
      buildClient: () => client,
    });

    await execute(enqueueAction("-", 1800)());

    expect(client.sets).toEqual([{ operation: "=", seconds: 0 }]);
  });

  it("applies a `=` set without reading userinfo", async () => {
    const client = fakeClient(undefined);
    const execute = createTimeTodayExecutor({
      db,
      defaultTz: "UTC",
      now: () => NOW,
      buildClient: () => client,
    });

    await execute(enqueueAction("=", 1200)());

    expect(client.reads).toBe(0);
    expect(client.sets).toEqual([{ operation: "=", seconds: 1200 }]);
  });

  it("drops (no-ops) an adjustment whose target day has rolled over", async () => {
    const client = fakeClient(3600);
    const execute = createTimeTodayExecutor({
      db,
      defaultTz: "UTC",
      now: () => NOW, // 2026-06-23
      buildClient: () => client,
    });

    await execute(enqueueAction("+", 1800, "2026-06-22")()); // target day already past

    expect(client.reads).toBe(0);
    expect(client.sets).toEqual([]);
  });

  it("rejects non-retriably when userinfo lacks TIME_LEFT_DAY", async () => {
    const client = fakeClient(undefined);
    const execute = createTimeTodayExecutor({
      db,
      defaultTz: "UTC",
      now: () => NOW,
      buildClient: () => client,
    });

    await expect(execute(enqueueAction("+", 1800)())).rejects.toThrow(/TIME_LEFT_DAY/);
    expect(client.sets).toEqual([]);
  });

  it("no-ops when the client was deleted before replay", async () => {
    const client = fakeClient(3600);
    const action = enqueueAction("+", 1800);
    const built = action();
    const execute = createTimeTodayExecutor({
      db,
      defaultTz: "UTC",
      now: () => NOW,
      buildClient: () => client,
    });
    // Point at a non-existent client id.
    await execute({ ...built, clientId: 9999 });
    expect(client.sets).toEqual([]);
  });
});
