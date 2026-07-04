/**
 * Unit tests for the offline-queue repository (#84) against a hermetic
 * in-memory policy DB (`testDb`, foreign_keys ON). Covers enqueue + structural
 * coalescing, the ordered/visibility reads, the scheduler's candidate query,
 * per-client counts, drain deletion, retriable attempt recording, and
 * dead-lettering — plus ON DELETE CASCADE with the owning client.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClient } from "../../../src/policy/repository.js";
import * as queue from "../../../src/transport/queue/repository.js";
import type { NewQueuedAction } from "../../../src/transport/queue/types.js";
import { testDb, type TestDb } from "../../helpers/db.js";

function action(overrides: Partial<NewQueuedAction> & { clientId: number }): NewQueuedAction {
  return {
    coalesceKey: "user:1",
    kind: "policy.push",
    payload: { reason: "user.updated" },
    ...overrides,
  };
}

describe("offline-queue repository", () => {
  let db: TestDb;
  let clientId: number;
  let otherClientId: number;

  beforeEach(() => {
    db = testDb();
    clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    otherClientId = createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("enqueues an action with pending defaults", () => {
    const row = queue.enqueue(db, action({ clientId }));
    expect(row.id).toBeGreaterThan(0);
    expect(row.clientId).toBe(clientId);
    expect(row.coalesceKey).toBe("user:1");
    expect(row.kind).toBe("policy.push");
    expect(row.payload).toEqual({ reason: "user.updated" });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.enqueuedAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("coalesces a newer push onto the same (client, coalesceKey), keeping position", () => {
    const first = queue.enqueue(db, action({ clientId, payload: { v: 1 } }));
    // A different target on the same client gets its own row.
    queue.enqueue(db, action({ clientId, coalesceKey: "client", payload: { v: 2 } }));
    const coalesced = queue.enqueue(db, action({ clientId, payload: { v: 3 } }));

    // Same row id (in-place upsert), newest payload wins.
    expect(coalesced.id).toBe(first.id);
    expect(coalesced.payload).toEqual({ v: 3 });

    const pending = queue.listPendingForClient(db, clientId);
    expect(pending).toHaveLength(2);
    // FIFO position preserved: the coalesced "user:1" still leads "client".
    expect(pending.map((r) => r.coalesceKey)).toEqual(["user:1", "client"]);
    expect(pending[0]?.enqueuedAt.getTime()).toBe(first.enqueuedAt.getTime());
  });

  it("resets a dead-lettered row to pending when the target is re-enqueued", () => {
    const row = queue.enqueue(db, action({ clientId }));
    queue.markFailed(db, row.id, "boom");
    expect(queue.listPendingForClient(db, clientId)).toHaveLength(0);

    const revived = queue.enqueue(db, action({ clientId, payload: { v: 9 } }));
    expect(revived.id).toBe(row.id);
    expect(revived.status).toBe("pending");
    expect(revived.attempts).toBe(0);
    expect(revived.lastError).toBeNull();
    expect(revived.payload).toEqual({ v: 9 });
  });

  it("lists pending oldest-first and all rows (pending + failed) for visibility", () => {
    const a = queue.enqueue(db, action({ clientId, coalesceKey: "a" }));
    const b = queue.enqueue(db, action({ clientId, coalesceKey: "b" }));
    queue.markFailed(db, b.id, "nope");

    expect(queue.listPendingForClient(db, clientId).map((r) => r.id)).toEqual([a.id]);
    expect(queue.listForClient(db, clientId).map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("reports clients with pending work and per-client counts", () => {
    queue.enqueue(db, action({ clientId, coalesceKey: "a" }));
    queue.enqueue(db, action({ clientId, coalesceKey: "b" }));
    const onOther = queue.enqueue(db, action({ clientId: otherClientId, coalesceKey: "a" }));
    queue.markFailed(db, onOther.id, "x"); // dead-lettered → not "pending"

    expect(queue.clientsWithPending(db)).toEqual([clientId]);
    expect(queue.countPendingByClient(db)).toEqual([{ clientId, count: 2 }]);
  });

  it("markDrained deletes the row and is idempotent", () => {
    const row = queue.enqueue(db, action({ clientId }));
    expect(queue.markDrained(db, row.id)).toBe(true);
    expect(queue.markDrained(db, row.id)).toBe(false);
    expect(queue.listForClient(db, clientId)).toHaveLength(0);
  });

  it("recordAttempt bumps attempts, stores last_error, keeps it pending", () => {
    const row = queue.enqueue(db, action({ clientId }));
    const after = queue.recordAttempt(db, row.id, "host unreachable");
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toBe("host unreachable");
    expect(after?.status).toBe("pending");
    expect(queue.recordAttempt(db, row.id, "again")?.attempts).toBe(2);
  });

  it("markFailed bumps attempts and dead-letters", () => {
    const row = queue.enqueue(db, action({ clientId }));
    const after = queue.markFailed(db, row.id, "exit code 1");
    expect(after?.status).toBe("failed");
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toBe("exit code 1");
  });

  it("returns undefined when updating a row that no longer exists", () => {
    expect(queue.recordAttempt(db, 999, "x")).toBeUndefined();
    expect(queue.markFailed(db, 999, "x")).toBeUndefined();
  });

  it("cascades queued rows away when the owning client is deleted", () => {
    const row = queue.enqueue(db, action({ clientId }));
    db.$client.prepare("DELETE FROM clients WHERE id = ?").run(clientId);
    expect(queue.listForClient(db, clientId)).toHaveLength(0);
    expect(queue.markDrained(db, row.id)).toBe(false);
  });

  describe("queueSummary (#322)", () => {
    it("is empty when the queue has no rows", () => {
      expect(queue.queueSummary(db)).toEqual({ pending: 0, failed: 0, oldestPendingAt: null });
    });

    it("counts pending and failed across all clients", () => {
      queue.enqueue(db, action({ clientId, coalesceKey: "user:1" }));
      queue.enqueue(db, action({ clientId, coalesceKey: "user:2" }));
      queue.enqueue(db, action({ clientId: otherClientId, coalesceKey: "user:3" }));
      const doomed = queue.enqueue(db, action({ clientId: otherClientId, coalesceKey: "user:4" }));
      queue.markFailed(db, doomed.id, "exit code 1");

      const summary = queue.queueSummary(db);
      expect(summary.pending).toBe(3);
      expect(summary.failed).toBe(1);
    });

    it("anchors oldestPendingAt to the earliest pending row", () => {
      const first = queue.enqueue(db, action({ clientId, coalesceKey: "user:1" }));
      queue.enqueue(db, action({ clientId, coalesceKey: "user:2" }));

      const summary = queue.queueSummary(db);
      expect(summary.oldestPendingAt).toBeInstanceOf(Date);
      expect(summary.oldestPendingAt?.getTime()).toBe(first.enqueuedAt.getTime());
    });

    it("ignores failed rows when anchoring oldestPendingAt", () => {
      // The first (oldest) row is dead-lettered; the later pending row must win.
      const doomed = queue.enqueue(db, action({ clientId, coalesceKey: "user:1" }));
      queue.markFailed(db, doomed.id, "exit code 1");
      const pending = queue.enqueue(db, action({ clientId, coalesceKey: "user:2" }));

      const summary = queue.queueSummary(db);
      expect(summary.pending).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.oldestPendingAt?.getTime()).toBe(pending.enqueuedAt.getTime());
    });

    it("reports oldestPendingAt null when only failed rows remain", () => {
      const doomed = queue.enqueue(db, action({ clientId }));
      queue.markFailed(db, doomed.id, "exit code 1");

      const summary = queue.queueSummary(db);
      expect(summary).toEqual({ pending: 0, failed: 1, oldestPendingAt: null });
    });
  });
});
