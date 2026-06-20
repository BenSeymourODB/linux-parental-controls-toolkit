/**
 * Unit tests for the live policy-push executor (#201): resolving a user's
 * effective overall policy from the store and driving the `timekpra` setters,
 * the no-op branches (client-scoped / missing client / missing link), and the
 * error propagation the offline queue classifies on.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createBudget,
  createClient,
  createSchedule,
  createUser,
  upsertLink,
} from "../../../src/policy/repository.js";
import {
  createPolicyPushExecutor,
  type PolicyPushClient,
  type PolicyPushClientTarget,
} from "../../../src/transport/policy-push/executor.js";
import type { QueuedAction } from "../../../src/transport/queue/types.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

/** A recording `PolicyPushClient` plus the factory input it was built with. */
interface RecordedClient {
  readonly client: PolicyPushClient;
  readonly calls: string[];
  built?: PolicyPushClientTarget;
}

function recordingClient(behaviour?: { rejectWith?: Error }): RecordedClient {
  const calls: string[] = [];
  const maybeReject = async (): Promise<void> => {
    if (behaviour?.rejectWith) throw behaviour.rejectWith;
  };
  const rec: RecordedClient = {
    calls,
    client: {
      async setTimeLimits(perDay) {
        calls.push(`setTimeLimits:${perDay.join(",")}`);
        await maybeReject();
      },
      async setTimeLimitWeek(seconds) {
        calls.push(`setTimeLimitWeek:${seconds}`);
        await maybeReject();
      },
      async setTimeLimitMonth(seconds) {
        calls.push(`setTimeLimitMonth:${seconds}`);
        await maybeReject();
      },
      async setWeeklyAllowedHours(weekly) {
        calls.push(`setWeeklyAllowedHours:${weekly.size}`);
        await maybeReject();
      },
    },
  };
  return rec;
}

/** A user-scoped `policy.push` action targeting `clientId` for `userId`. */
function action(clientId: number, userId: number | null): QueuedAction {
  return {
    clientId,
    coalesceKey: userId === null ? "client" : `user:${userId}`,
    kind: "policy.push",
    payload: { userId, reason: "budget.updated", detail: {} },
  };
}

describe("createPolicyPushExecutor", () => {
  let db: TestDb;

  function setup(): { userId: number; clientId: number } {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { linuxUsername: "alice", linuxUid: 1001 });
    return { userId, clientId };
  }

  it("pushes the resolved daily limit and the weekly allowed-hours grid", async () => {
    const { userId, clientId } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });

    const rec = recordingClient();
    const executor = createPolicyPushExecutor({
      db,
      defaultTz: "UTC",
      buildClient: (t) => {
        rec.built = t;
        return rec.client;
      },
    });

    await executor(action(clientId, userId));

    expect(rec.built).toMatchObject({ username: "alice", userId, reason: "budget.updated" });
    expect(rec.built?.client.id).toBe(clientId);
    expect(rec.calls).toEqual([
      "setTimeLimits:7200,7200,7200,7200,7200,7200,7200",
      "setWeeklyAllowedHours:7",
    ]);
  });

  it("pushes rolling weekly and monthly limits when defined", async () => {
    const { userId, clientId } = setup();
    createBudget(db, { userId, scope: "overall", window: "weekly", secondsAllowed: 36000 });
    createBudget(db, { userId, scope: "overall", window: "monthly", secondsAllowed: 100000 });

    const rec = recordingClient();
    const executor = createPolicyPushExecutor({
      db,
      defaultTz: "UTC",
      buildClient: () => rec.client,
    });

    await executor(action(clientId, userId));

    // No daily budget → no setTimeLimits; weekly/monthly + allowed-hours present.
    expect(rec.calls).toEqual([
      "setTimeLimitWeek:36000",
      "setTimeLimitMonth:100000",
      "setWeeklyAllowedHours:7",
    ]);
  });

  it("still pushes the allowed-hours grid for a user with no budgets", async () => {
    const { userId, clientId } = setup();
    const rec = recordingClient();
    const executor = createPolicyPushExecutor({
      db,
      defaultTz: "UTC",
      buildClient: () => rec.client,
    });

    await executor(action(clientId, userId));

    expect(rec.calls).toEqual(["setWeeklyAllowedHours:7"]);
  });

  it("uses the server default timezone for a user with no tz override", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Bob", tz: null }).id;
    const clientId = createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { linuxUsername: "bob", linuxUid: 1002 });
    createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "deny",
      recurrenceStartMinute: 0,
      recurrenceEndMinute: 360,
    });

    const rec = recordingClient();
    const executor = createPolicyPushExecutor({
      db,
      defaultTz: "America/New_York",
      buildClient: () => rec.client,
    });

    await executor(action(clientId, userId));
    // The push reaches the client (default tz resolved without throwing).
    expect(rec.calls).toEqual(["setWeeklyAllowedHours:7"]);
  });

  it("is a no-op for a client-scoped change (null user)", async () => {
    const { clientId } = setup();
    const build = vi.fn();
    const executor = createPolicyPushExecutor({ db, defaultTz: "UTC", buildClient: build });

    await executor(action(clientId, null));
    expect(build).not.toHaveBeenCalled();
  });

  it("is a no-op when the client no longer exists", async () => {
    const { userId } = setup();
    const build = vi.fn();
    const executor = createPolicyPushExecutor({ db, defaultTz: "UTC", buildClient: build });

    await executor(action(9999, userId));
    expect(build).not.toHaveBeenCalled();
  });

  it("is a no-op when the user is not linked to the client", async () => {
    const { userId, clientId } = setup();
    const otherClientId = createClient(db, { hostname: "mint-09", sshUser: "pct-agent" }).id;
    const build = vi.fn();
    const executor = createPolicyPushExecutor({ db, defaultTz: "UTC", buildClient: build });

    // The user is linked to `clientId`, not `otherClientId`.
    expect(otherClientId).not.toBe(clientId);
    await executor(action(otherClientId, userId));
    expect(build).not.toHaveBeenCalled();
  });

  it("propagates a retriable (unreachable) failure for the queue to keep", async () => {
    const { userId, clientId } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });
    const rec = recordingClient({ rejectWith: new SshUnreachableError(target) });
    const executor = createPolicyPushExecutor({
      db,
      defaultTz: "UTC",
      buildClient: () => rec.client,
    });

    await expect(executor(action(clientId, userId))).rejects.toBeInstanceOf(SshUnreachableError);
  });

  it("propagates a non-retriable command failure for dead-lettering", async () => {
    const { userId, clientId } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });
    const rec = recordingClient({
      rejectWith: new SshCommandError(target, ["timekpra"], {
        stdout: "",
        stderr: "boom",
        code: 1,
        signal: null,
      }),
    });
    const executor = createPolicyPushExecutor({
      db,
      defaultTz: "UTC",
      buildClient: () => rec.client,
    });

    await expect(executor(action(clientId, userId))).rejects.toBeInstanceOf(SshCommandError);
  });

  it("rejects a malformed queue payload rather than mis-pushing", async () => {
    const { clientId } = setup();
    const executor = createPolicyPushExecutor({
      db,
      defaultTz: "UTC",
      buildClient: () => recordingClient().client,
    });

    await expect(
      executor({ clientId, coalesceKey: "user:1", kind: "policy.push", payload: { nope: true } }),
    ).rejects.toBeTruthy();
  });
});
