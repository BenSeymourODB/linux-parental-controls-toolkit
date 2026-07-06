/**
 * Unit tests for the manual "push saved policy now" lever (#304): the awaitable
 * re-push over the shared executor path — per-client pushed/queued/failed
 * results, offline-queue persistence on a retriable failure, targeting errors,
 * and single-client vs all-clients fan-out.
 */
import { describe, expect, it } from "vitest";

import { createClient, createUser, upsertLink } from "../../../src/policy/repository.js";
import {
  pushUserPolicyNow,
  PushNowTargetError,
} from "../../../src/transport/policy-push/push-now.js";
import { listPendingForClient } from "../../../src/transport/queue/repository.js";
import type { ActionExecutor, QueuedAction } from "../../../src/transport/queue/types.js";
import { SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

/**
 * A recording executor. `behaviour` maps a `clientId` to what its push does:
 * resolve (default), throw a retriable (unreachable) error, or throw a
 * non-retriable one. Records every action it was invoked with.
 */
function recordingExecutor(behaviour: Record<number, "ok" | "unreachable" | "boom"> = {}): {
  executor: ActionExecutor;
  calls: QueuedAction[];
} {
  const calls: QueuedAction[] = [];
  const executor: ActionExecutor = async (action) => {
    calls.push(action);
    const outcome = behaviour[action.clientId] ?? "ok";
    if (outcome === "unreachable") throw new SshUnreachableError(target);
    if (outcome === "boom") throw new Error("timekpra: command failed");
  };
  return { executor, calls };
}

describe("pushUserPolicyNow (#304)", () => {
  let db: TestDb;

  function linkClient(userId: number, hostname: string, osUsername: string): number {
    const clientId = createClient(db, { hostname, sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername, osUserRef: "1001" });
    return clientId;
  }

  it("pushes the saved policy to every linked client and reports each pushed", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const c1 = linkClient(userId, "mint-01", "alice");
    const c2 = linkClient(userId, "mint-02", "alice");
    const { executor, calls } = recordingExecutor();

    const { results } = await pushUserPolicyNow(db, executor, { userId });

    expect(calls).toHaveLength(2);
    // Each command is user-scoped so the executor recomputes the whole policy,
    // carrying the `user.updated` reason + the manual-push trigger in the payload.
    expect(calls.every((a) => a.coalesceKey === `user:${userId}`)).toBe(true);
    expect(calls[0]).toMatchObject({
      kind: "policy.push",
      payload: { userId, reason: "user.updated", detail: { trigger: "manual.push-now" } },
    });
    expect(results).toEqual([
      { clientId: c1, hostname: "mint-01", osUsername: "alice", status: "pushed" },
      { clientId: c2, hostname: "mint-02", osUsername: "alice", status: "pushed" },
    ]);
    // A successful push queues nothing.
    expect(listPendingForClient(db, c1)).toHaveLength(0);
  });

  it("restricts the push to a single requested client", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const c1 = linkClient(userId, "mint-01", "alice");
    const c2 = linkClient(userId, "mint-02", "alice");
    const { executor, calls } = recordingExecutor();

    const { results } = await pushUserPolicyNow(db, executor, { userId, clientId: c2 });

    expect(calls.map((a) => a.clientId)).toEqual([c2]);
    expect(results).toEqual([
      { clientId: c2, hostname: "mint-02", osUsername: "alice", status: "pushed" },
    ]);
    expect(listPendingForClient(db, c1)).toHaveLength(0);
  });

  it("queues an unreachable client for replay and reports it queued", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const c1 = linkClient(userId, "mint-01", "alice");
    const { executor } = recordingExecutor({ [c1]: "unreachable" });

    const { results } = await pushUserPolicyNow(db, executor, { userId });

    expect(results[0]?.status).toBe("queued");
    expect(results[0]?.error).toBeDefined();
    // The idempotent absolute push is durably persisted for the drainer.
    expect(listPendingForClient(db, c1)).toHaveLength(1);
  });

  it("reports a non-retriable failure as failed and queues nothing", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const c1 = linkClient(userId, "mint-01", "alice");
    const { executor } = recordingExecutor({ [c1]: "boom" });

    const { results } = await pushUserPolicyNow(db, executor, { userId });

    expect(results[0]).toMatchObject({ status: "failed", error: "timekpra: command failed" });
    expect(listPendingForClient(db, c1)).toHaveLength(0);
  });

  it("returns a full report across a mixed fan-out", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const c1 = linkClient(userId, "mint-01", "alice");
    const c2 = linkClient(userId, "mint-02", "alice");
    const c3 = linkClient(userId, "mint-03", "alice");
    const { executor } = recordingExecutor({ [c2]: "unreachable", [c3]: "boom" });

    const { results } = await pushUserPolicyNow(db, executor, { userId });

    expect(results.map((r) => r.status)).toEqual(["pushed", "queued", "failed"]);
    expect(results.map((r) => r.clientId)).toEqual([c1, c2, c3]);
  });

  it("throws PushNowTargetError when the requested client is not linked", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    linkClient(userId, "mint-01", "alice");
    const other = createClient(db, { hostname: "mint-99", sshUser: "pct-agent" }).id;
    const { executor } = recordingExecutor();

    await expect(
      pushUserPolicyNow(db, executor, { userId, clientId: other }),
    ).rejects.toBeInstanceOf(PushNowTargetError);
  });

  it("throws PushNowTargetError when the user has no linked clients", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const { executor } = recordingExecutor();

    await expect(pushUserPolicyNow(db, executor, { userId })).rejects.toBeInstanceOf(
      PushNowTargetError,
    );
  });
});
