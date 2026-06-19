/**
 * Unit tests for pushOrEnqueue (#84): pushes propagate immediately when the
 * client is reachable, queue on a retriable failure, and re-throw a
 * non-retriable failure rather than silently queuing a doomed command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../../../src/policy/repository.js";
import { pushOrEnqueue } from "../../../src/transport/queue/facade.js";
import * as queue from "../../../src/transport/queue/repository.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import type { NewQueuedAction } from "../../../src/transport/queue/types.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

describe("pushOrEnqueue", () => {
  let db: TestDb;
  let action: NewQueuedAction;

  beforeEach(() => {
    db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    action = { clientId, coalesceKey: "user:1", kind: "policy.push", payload: { reason: "x" } };
  });
  afterEach(() => {
    db.$client.close();
  });

  it("pushes immediately and queues nothing when the client is reachable", async () => {
    const executor = vi.fn(async () => undefined);
    const outcome = await pushOrEnqueue(db, action, executor);

    expect(outcome).toEqual({ status: "pushed" });
    expect(executor).toHaveBeenCalledWith({
      clientId: action.clientId,
      coalesceKey: "user:1",
      kind: "policy.push",
      payload: { reason: "x" },
    });
    expect(queue.listForClient(db, action.clientId)).toHaveLength(0);
  });

  it("queues the action on a retriable (unreachable) failure", async () => {
    const executor = vi.fn(async () => {
      throw new SshUnreachableError(target);
    });
    const outcome = await pushOrEnqueue(db, action, executor);

    expect(outcome.status).toBe("queued");
    expect(outcome).toMatchObject({ reason: expect.stringMatching(/unreachable/i) });
    const queued = queue.listPendingForClient(db, action.clientId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.coalesceKey).toBe("user:1");
  });

  it("coalesces repeated retriable pushes for the same target into one row", async () => {
    const executor = async (): Promise<void> => {
      throw new SshUnreachableError(target);
    };
    await pushOrEnqueue(db, { ...action, payload: { reason: "first" } }, executor);
    await pushOrEnqueue(db, { ...action, payload: { reason: "second" } }, executor);

    const queued = queue.listPendingForClient(db, action.clientId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ reason: "second" }); // newest wins
  });

  it("re-throws a non-retriable failure without queuing", async () => {
    const executor = vi.fn(async () => {
      throw new SshCommandError(target, ["timekpra"], {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "bad args",
      });
    });

    await expect(pushOrEnqueue(db, action, executor)).rejects.toBeInstanceOf(SshCommandError);
    expect(queue.listForClient(db, action.clientId)).toHaveLength(0);
  });
});
