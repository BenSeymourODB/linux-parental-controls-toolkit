/**
 * Unit tests for the offline-queue drainer (#84): the replay loop's success /
 * retriable-defer / non-retriable-dead-letter behaviour, ordering, and the
 * never-rejects contract. The executor is a mock; the SSH error taxonomy
 * supplies realistic retriable/non-retriable rejections.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../../../src/policy/repository.js";
import { drainClient } from "../../../src/transport/queue/drainer.js";
import * as queue from "../../../src/transport/queue/repository.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import type { QueuedAction } from "../../../src/transport/queue/types.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;
const unreachable = (): SshUnreachableError => new SshUnreachableError(target);
const commandFailed = (): SshCommandError =>
  new SshCommandError(target, ["timekpra"], { code: 1, signal: null, stdout: "", stderr: "no" });

describe("drainClient", () => {
  let db: TestDb;
  let clientId: number;

  beforeEach(() => {
    db = testDb();
    clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  function enqueueN(keys: readonly string[]): void {
    for (const coalesceKey of keys) {
      queue.enqueue(db, {
        clientId,
        coalesceKey,
        kind: "policy.push",
        payload: { k: coalesceKey },
      });
    }
  }

  it("drains every action in order and removes them", async () => {
    enqueueN(["a", "b", "c"]);
    const seen: string[] = [];
    const executor = vi.fn(async (action: QueuedAction) => {
      seen.push(action.coalesceKey);
    });

    const summary = await drainClient(db, clientId, executor);

    expect(seen).toEqual(["a", "b", "c"]); // FIFO order
    expect(summary).toEqual({ drained: 3, failed: 0, deferred: 0 });
    expect(queue.listForClient(db, clientId)).toHaveLength(0);
  });

  it("stops at the first retriable failure and defers the remainder", async () => {
    enqueueN(["a", "b", "c"]);
    const executor = vi.fn(async (action: QueuedAction) => {
      if (action.coalesceKey === "b") throw unreachable();
    });

    const summary = await drainClient(db, clientId, executor);

    // a drained; b deferred (recorded attempt, still pending); c never tried.
    expect(executor).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ drained: 1, failed: 0, deferred: 2 });

    const pending = queue.listPendingForClient(db, clientId);
    expect(pending.map((r) => r.coalesceKey)).toEqual(["b", "c"]);
    expect(pending[0]?.attempts).toBe(1);
    expect(pending[0]?.lastError).toMatch(/unreachable/i);
    expect(pending[1]?.attempts).toBe(0); // c untouched
  });

  it("dead-letters a non-retriable failure and keeps draining the rest", async () => {
    enqueueN(["a", "b", "c"]);
    const executor = vi.fn(async (action: QueuedAction) => {
      if (action.coalesceKey === "b") throw commandFailed();
    });

    const summary = await drainClient(db, clientId, executor);

    expect(executor).toHaveBeenCalledTimes(3); // poison row doesn't block the head
    expect(summary).toEqual({ drained: 2, failed: 1, deferred: 0 });

    expect(queue.listPendingForClient(db, clientId)).toHaveLength(0);
    const all = queue.listForClient(db, clientId);
    expect(all).toHaveLength(1);
    expect(all[0]?.coalesceKey).toBe("b");
    expect(all[0]?.status).toBe("failed");
    expect(all[0]?.attempts).toBe(1);
  });

  it("treats an unclassifiable rejection as non-retriable (dead-letter)", async () => {
    enqueueN(["a"]);
    const executor = vi.fn(async () => {
      throw new Error("kaboom");
    });

    const summary = await drainClient(db, clientId, executor);

    expect(summary).toEqual({ drained: 0, failed: 1, deferred: 0 });
    expect(queue.listForClient(db, clientId)[0]?.status).toBe("failed");
  });

  it("is a no-op for a client with no pending actions", async () => {
    const executor = vi.fn();
    const summary = await drainClient(db, clientId, executor);
    expect(executor).not.toHaveBeenCalled();
    expect(summary).toEqual({ drained: 0, failed: 0, deferred: 0 });
  });

  it("ignores dead-lettered rows on a subsequent drain", async () => {
    enqueueN(["a"]);
    await drainClient(db, clientId, async () => {
      throw commandFailed();
    });
    const executor = vi.fn();
    const summary = await drainClient(db, clientId, executor);
    expect(executor).not.toHaveBeenCalled(); // failed row isn't pending
    expect(summary.drained).toBe(0);
  });
});
