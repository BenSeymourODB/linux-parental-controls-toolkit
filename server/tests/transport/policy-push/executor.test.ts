/**
 * Unit tests for the live policy-push executor (#201, #232): the
 * platform-agnostic dispatch in front of the per-platform runners —
 * the no-op branches (client-scoped / missing client / missing link /
 * unsupported platform), runner selection by `Client.platform`, payload
 * validation, and the error propagation the offline queue classifies on.
 *
 * The Linux runner's enforcement detail (the `timekpra` setter sequence and the
 * full-lockout skip) is exercised here through the real runner and also in
 * isolation in `linux-runner.test.ts`; the registry in `platform-runner.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import {
  createBudget,
  createClient,
  createSchedule,
  createUser,
  upsertLink,
} from "../../../src/policy/repository.js";
import { clients } from "../../../src/policy/schema.js";
import {
  createPolicyPushExecutor,
  type PolicyPushExecutorLogger,
} from "../../../src/transport/policy-push/executor.js";
import {
  createLinuxPolicyRunner,
  type PolicyPushClient,
  type PolicyPushClientFactory,
  type PolicyPushClientTarget,
  type PolicyPushRunnerLogger,
} from "../../../src/transport/policy-push/linux-runner.js";
import { createPlatformRunnerRegistry } from "../../../src/transport/policy-push/platform-runner.js";
import type { ActionExecutor, QueuedAction } from "../../../src/transport/queue/types.js";
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

/**
 * Build the executor wired with a Linux-only registry — the production default.
 * `runnerLog` is the Linux runner's logger (the full-lockout skip notice);
 * `executorLog` is the dispatcher's logger (the unsupported-platform skip).
 */
function linuxExecutor(args: {
  db: TestDb;
  defaultTz: string;
  buildClient: PolicyPushClientFactory;
  runnerLog?: PolicyPushRunnerLogger;
  executorLog?: PolicyPushExecutorLogger;
}): ActionExecutor {
  const runner = createLinuxPolicyRunner({
    buildClient: args.buildClient,
    ...(args.runnerLog !== undefined ? { log: args.runnerLog } : {}),
  });
  const registry = createPlatformRunnerRegistry([runner]);
  return createPolicyPushExecutor({
    db: args.db,
    defaultTz: args.defaultTz,
    registry,
    ...(args.executorLog !== undefined ? { log: args.executorLog } : {}),
  });
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

/**
 * A `link.deleted` (unmanage) `policy.push` action, mirroring what the DELETE
 * link route enqueues: the captured OS account name travels in `detail`
 * because the link row has already cascaded away (#253).
 */
function unlinkAction(
  clientId: number,
  userId: number,
  detail: Record<string, unknown> = { osUsername: "alice", osUserRef: "1001" },
): QueuedAction {
  return {
    clientId,
    coalesceKey: `user:${userId}`,
    kind: "policy.push",
    payload: { userId, reason: "link.deleted", detail },
  };
}

describe("createPolicyPushExecutor", () => {
  let db: TestDb;

  function setup(): { userId: number; clientId: number } {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    return { userId, clientId };
  }

  it("pushes the resolved daily limit and the weekly allowed-hours grid", async () => {
    const { userId, clientId } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });

    const rec = recordingClient();
    const executor = linuxExecutor({
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
    const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: () => rec.client });

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
    const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: () => rec.client });

    await executor(action(clientId, userId));

    expect(rec.calls).toEqual(["setWeeklyAllowedHours:7"]);
  });

  it("skips the allowed-hours push (and logs) for a fully-denied week, still pushing limits", async () => {
    const { userId, clientId } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 3600 });
    // An always-on overall deny denies access every day, all day → no allowed weekday.
    createSchedule(db, { userId, targetKind: "overall", action: "deny" });

    const rec = recordingClient();
    const warn = vi.fn();
    const executor = linuxExecutor({
      db,
      defaultTz: "UTC",
      runnerLog: { warn },
      buildClient: () => rec.client,
    });

    await executor(action(clientId, userId));

    // Limits still pushed; the unrepresentable allowed-hours push is skipped.
    expect(rec.calls).toEqual(["setTimeLimits:3600,3600,3600,3600,3600,3600,3600"]);
    expect(rec.calls).not.toContain("setWeeklyAllowedHours:7");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses the server default timezone for a user with no tz override", async () => {
    db = testDb();
    const userId = createUser(db, { displayName: "Bob", tz: null }).id;
    const clientId = createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername: "bob", osUserRef: "1002" });
    createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "deny",
      recurrenceStartMinute: 0,
      recurrenceEndMinute: 360,
    });

    const rec = recordingClient();
    const executor = linuxExecutor({
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
    const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: build });

    await executor(action(clientId, null));
    expect(build).not.toHaveBeenCalled();
  });

  it("is a no-op when the client no longer exists", async () => {
    const { userId } = setup();
    const build = vi.fn();
    const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: build });

    await executor(action(9999, userId));
    expect(build).not.toHaveBeenCalled();
  });

  it("is a no-op when the user is not linked to the client", async () => {
    const { userId, clientId } = setup();
    const otherClientId = createClient(db, { hostname: "mint-09", sshUser: "pct-agent" }).id;
    const build = vi.fn();
    const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: build });

    // The user is linked to `clientId`, not `otherClientId`.
    expect(otherClientId).not.toBe(clientId);
    await executor(action(otherClientId, userId));
    expect(build).not.toHaveBeenCalled();
  });

  describe("unlink unmanage push (#253)", () => {
    /** A user and client that exist but are *not* linked — the post-unlink state. */
    function unlinkedSetup(): { userId: number; clientId: number } {
      db = testDb();
      const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
      const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
      return { userId, clientId };
    }

    it("pushes the fully-unrestricted config when a link is deleted", async () => {
      const { userId, clientId } = unlinkedSetup();
      const rec = recordingClient();
      const executor = linuxExecutor({
        db,
        defaultTz: "UTC",
        buildClient: (t) => {
          rec.built = t;
          return rec.client;
        },
      });

      await executor(unlinkAction(clientId, userId));

      // Built with the username carried in the detail, attributed to link.deleted.
      expect(rec.built).toMatchObject({ username: "alice", userId, reason: "link.deleted" });
      expect(rec.built?.client.id).toBe(clientId);
      // Maximal limits (86400/day × 7, 604800/week, 31×86400/month) + all-hours,
      // every-day grid — so the allowed-hours push is never skipped.
      expect(rec.calls).toEqual([
        "setTimeLimits:86400,86400,86400,86400,86400,86400,86400",
        "setTimeLimitWeek:604800",
        "setTimeLimitMonth:2678400",
        "setWeeklyAllowedHours:7",
      ]);
    });

    it("ignores the user's stale policy rows when unmanaging", async () => {
      const { userId, clientId } = unlinkedSetup();
      // Leftover budget/schedule for the (now unlinked) user must not shape the
      // unmanage push — it is always the fixed unrestricted config.
      createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 3600 });
      createSchedule(db, { userId, targetKind: "overall", action: "deny" });

      const rec = recordingClient();
      const executor = linuxExecutor({
        db,
        defaultTz: "UTC",
        buildClient: () => rec.client,
      });

      await executor(unlinkAction(clientId, userId));

      expect(rec.calls).toEqual([
        "setTimeLimits:86400,86400,86400,86400,86400,86400,86400",
        "setTimeLimitWeek:604800",
        "setTimeLimitMonth:2678400",
        "setWeeklyAllowedHours:7",
      ]);
    });

    it("is a no-op when the link.deleted detail carries no usable username", async () => {
      const { userId, clientId } = unlinkedSetup();
      const build = vi.fn();
      const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: build });

      await executor(unlinkAction(clientId, userId, {}));
      await executor(unlinkAction(clientId, userId, { osUsername: "" }));
      expect(build).not.toHaveBeenCalled();
    });

    it("does not unmanage a non-link.deleted reason for an unlinked user", async () => {
      const { userId, clientId } = unlinkedSetup();
      const build = vi.fn();
      const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: build });

      // Same missing-link state, but a user-scoped edit reason — nothing to do.
      await executor({
        clientId,
        coalesceKey: `user:${userId}`,
        kind: "policy.push",
        payload: { userId, reason: "budget.updated", detail: { osUsername: "alice" } },
      });
      expect(build).not.toHaveBeenCalled();
    });

    it("is a no-op when the client no longer exists, even for a link.deleted", async () => {
      const { userId } = unlinkedSetup();
      const build = vi.fn();
      const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: build });

      await executor(unlinkAction(9999, userId));
      expect(build).not.toHaveBeenCalled();
    });
  });

  it("warns and no-ops for a client on a platform with no registered runner (#232)", async () => {
    const { userId } = setup();
    // A `windows` client: the Linux-only registry has no runner for it, so the
    // dispatcher must skip rather than push the `timekpra` path to a non-Linux box.
    const winClientId = db
      .insert(clients)
      .values({ hostname: "win-01", sshUser: "pct-agent", platform: "windows" })
      .returning()
      .get().id;
    upsertLink(db, userId, winClientId, { osUsername: "alice", osUserRef: "1001" });
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });

    const build = vi.fn();
    const warn = vi.fn();
    const executor = linuxExecutor({
      db,
      defaultTz: "UTC",
      buildClient: build,
      executorLog: { warn },
    });

    // Resolves without throwing (not a command failure → not dead-lettered)…
    await executor(action(winClientId, userId));
    // …no Linux client is ever built, and the skip is surfaced once.
    expect(build).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ platform: "windows", userId });
  });

  it("propagates a retriable (unreachable) failure for the queue to keep", async () => {
    const { userId, clientId } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });
    const rec = recordingClient({ rejectWith: new SshUnreachableError(target) });
    const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: () => rec.client });

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
    const executor = linuxExecutor({ db, defaultTz: "UTC", buildClient: () => rec.client });

    await expect(executor(action(clientId, userId))).rejects.toBeInstanceOf(SshCommandError);
  });

  it("rejects a malformed queue payload rather than mis-pushing", async () => {
    const { clientId } = setup();
    const executor = linuxExecutor({
      db,
      defaultTz: "UTC",
      buildClient: () => recordingClient().client,
    });

    await expect(
      executor({ clientId, coalesceKey: "user:1", kind: "policy.push", payload: { nope: true } }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
