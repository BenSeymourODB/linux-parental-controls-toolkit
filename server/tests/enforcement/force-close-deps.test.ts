/**
 * Tests for the live force-close deps factory (#99) against a hermetic in-memory
 * policy DB (`testDb()`), with faked SSH facade / audit sink / event hub.
 * Covers the DB resolutions (clients-for-user join, activity- and group-scope
 * activity resolution with the app-kind filter), the `pkill` outcome mapping
 * incl. exit-1-is-ok and the SSH error taxonomy, the empty-pattern skip, and
 * the event-stream audit row shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createForceCloseDeps } from "../../src/enforcement/force-close-deps.js";
import type { ForceCloseClient } from "../../src/enforcement/force-close.js";
import type { AuditEntry } from "../../src/transport/audit/index.js";
import { SshExecTimeoutError, SshUnreachableError } from "../../src/transport/ssh/errors.js";
import type { ExecResult, SshCredentials, SshTarget } from "../../src/transport/ssh/index.js";
import {
  activities,
  activitiesToGroups,
  activityGroups,
  clients,
  users,
  usersOnClients,
} from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

const CREDENTIALS: SshCredentials = { privateKey: "KEY", port: 2222 };

function execOk(code: number): ExecResult {
  return { stdout: "", stderr: "", code, signal: null };
}

let db: TestDb;
let userId: number;
let clientId: number;

beforeEach(() => {
  db = testDb();
  userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
  clientId = db
    .insert(clients)
    .values({ hostname: "alice-pc", sshUser: "pct-agent" })
    .returning()
    .get().id;
  db.insert(usersOnClients)
    .values({ userId, clientId, osUsername: "alice", osUserRef: "1001" })
    .run();
});

afterEach(() => {
  db.$client.close();
});

function makeDeps(
  over: {
    ssh?: { exec: ReturnType<typeof vi.fn> };
    sink?: { record: ReturnType<typeof vi.fn> };
  } = {},
) {
  const exec = over.ssh?.exec ?? vi.fn(async () => execOk(0));
  const record = over.sink?.record ?? vi.fn();
  const publishToClient = vi.fn(() => 1);
  const deps = createForceCloseDeps({
    db,
    eventHub: { publishToClient },
    ssh: { exec },
    credentials: CREDENTIALS,
    sink: { record },
    logger: { warn: vi.fn(), error: vi.fn() },
    schedule: (cb) => cb(),
  });
  return { deps, exec, record, publishToClient };
}

describe("createForceCloseDeps — clientsForUser", () => {
  it("joins users_on_clients ⋈ clients and resolves the SSH target with credentials", () => {
    const { deps } = makeDeps();
    const result = deps.clientsForUser(userId);
    expect(result).toHaveLength(1);
    const client = result[0] as ForceCloseClient;
    expect(client.clientId).toBe(clientId);
    expect(client.osUserRef).toBe("1001");
    expect(client.sshTarget).toMatchObject({
      host: "alice-pc",
      username: "pct-agent",
      privateKey: "KEY",
      port: 2222,
    });
  });

  it("returns nothing for a user enrolled on no clients", () => {
    const other = db.insert(users).values({ displayName: "Bob" }).returning().get().id;
    const { deps } = makeDeps();
    expect(deps.clientsForUser(other)).toEqual([]);
  });
});

describe("createForceCloseDeps — resolveActivities", () => {
  it("activity scope returns the app activity itself", () => {
    const id = db
      .insert(activities)
      .values({ kind: "app", matcher: "firefox" })
      .returning()
      .get().id;
    const { deps } = makeDeps();
    expect(deps.resolveActivities("activity", id)).toEqual([
      { activityId: id, matcher: "firefox", matchType: "exact" },
    ]);
  });

  it("excludes non-app (domain) activities — those are web-filter enforcement", () => {
    const id = db
      .insert(activities)
      .values({ kind: "domain", matcher: "youtube.com" })
      .returning()
      .get().id;
    const { deps } = makeDeps();
    expect(deps.resolveActivities("activity", id)).toEqual([]);
  });

  it("group scope expands to the group's app members only", () => {
    const groupId = db.insert(activityGroups).values({ name: "Games" }).returning().get().id;
    const steam = db
      .insert(activities)
      .values({ kind: "app", matcher: "steam" })
      .returning()
      .get().id;
    const minecraft = db
      .insert(activities)
      .values({ kind: "app", matcher: "minecraft", matchType: "substring" })
      .returning()
      .get().id;
    const site = db
      .insert(activities)
      .values({ kind: "domain", matcher: "twitch.tv" })
      .returning()
      .get().id;
    db.insert(activitiesToGroups)
      .values([
        { activityId: steam, groupId },
        { activityId: minecraft, groupId },
        { activityId: site, groupId },
      ])
      .run();

    const { deps } = makeDeps();
    const resolved = deps.resolveActivities("group", groupId);
    expect(resolved).toEqual(
      expect.arrayContaining([
        { activityId: steam, matcher: "steam", matchType: "exact" },
        { activityId: minecraft, matcher: "minecraft", matchType: "substring" },
      ]),
    );
    expect(resolved).toHaveLength(2); // the domain member is excluded
  });
});

describe("createForceCloseDeps — forceCloseOverSsh", () => {
  const activity = { activityId: 7, matcher: "firefox", matchType: "exact" as const };

  function clientFixture(): ForceCloseClient {
    return {
      clientId,
      osUserRef: "1001",
      sshTarget: {
        host: "alice-pc",
        username: "pct-agent",
        privateKey: "KEY",
        port: 2222,
      } as SshTarget,
    };
  }

  it("runs the user-scoped pkill and audits a matched kill (exit 0) as ok", async () => {
    const { deps, exec, record } = makeDeps();
    await deps.forceCloseOverSsh({ client: clientFixture(), activity, userId });
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ host: "alice-pc" }), [
      "pkill",
      "-u",
      "1001",
      "-x",
      "firefox",
    ]);
    const entry = record.mock.calls[0]?.[0] as AuditEntry;
    expect(entry.outcome).toBe("ok");
    expect(entry.exitCode).toBe(0);
    expect(entry.context).toMatchObject({ clientId, userId, actor: "system" });
  });

  it("treats pkill exit 1 (no matching process) as ok, not a failure", async () => {
    const { deps, record } = makeDeps({ ssh: { exec: vi.fn(async () => execOk(1)) } });
    await deps.forceCloseOverSsh({ client: clientFixture(), activity, userId });
    expect((record.mock.calls[0]?.[0] as AuditEntry).outcome).toBe("ok");
  });

  it("records a usage/fatal exit (2) as failed", async () => {
    const { deps, record } = makeDeps({ ssh: { exec: vi.fn(async () => execOk(2)) } });
    await deps.forceCloseOverSsh({ client: clientFixture(), activity, userId });
    expect((record.mock.calls[0]?.[0] as AuditEntry).outcome).toBe("failed");
  });

  it("maps an unreachable host to the unreachable outcome", async () => {
    const exec = vi.fn(async () => {
      throw new SshUnreachableError(
        { host: "alice-pc", port: 2222, username: "pct-agent" },
        { cause: new Error("ECONNREFUSED") },
      );
    });
    const { deps, record } = makeDeps({ ssh: { exec } });
    await deps.forceCloseOverSsh({ client: clientFixture(), activity, userId });
    expect((record.mock.calls[0]?.[0] as AuditEntry).outcome).toBe("unreachable");
  });

  it("maps an exec timeout to the timeout outcome", async () => {
    const exec = vi.fn(async () => {
      throw new SshExecTimeoutError(
        { host: "alice-pc", port: 2222, username: "pct-agent" },
        ["pkill"],
        30_000,
      );
    });
    const { deps, record } = makeDeps({ ssh: { exec } });
    await deps.forceCloseOverSsh({ client: clientFixture(), activity, userId });
    expect((record.mock.calls[0]?.[0] as AuditEntry).outcome).toBe("timeout");
  });

  it("records an unexpected (non-SSH) throw as failed rather than dropping it", async () => {
    const exec = vi.fn(async () => {
      throw new Error("kernel panic");
    });
    const { deps, record } = makeDeps({ ssh: { exec } });
    await deps.forceCloseOverSsh({ client: clientFixture(), activity, userId });
    const entry = record.mock.calls[0]?.[0] as AuditEntry;
    expect(entry.outcome).toBe("failed");
    expect(entry.errorMessage).toContain("kernel panic");
  });

  it("skips and does not exec when the matcher yields an empty pattern", async () => {
    const { deps, exec, record } = makeDeps();
    await deps.forceCloseOverSsh({
      client: clientFixture(),
      activity: { activityId: 7, matcher: "", matchType: "exact" },
      userId,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("createForceCloseDeps — recordEventAudit", () => {
  it("records the event-stream emission against the client target as ok", () => {
    const { deps, record } = makeDeps();
    deps.recordEventAudit({
      client: {
        clientId,
        osUserRef: "1001",
        sshTarget: {
          host: "alice-pc",
          username: "pct-agent",
          privateKey: "KEY",
          port: 2222,
        } as SshTarget,
      },
      userId,
      activityId: 7,
    });
    const entry = record.mock.calls[0]?.[0] as AuditEntry;
    expect(entry.outcome).toBe("ok");
    expect(entry.target).toEqual({ host: "alice-pc", port: 2222, username: "pct-agent" });
    expect(entry.command).toEqual([
      "enforce.force_close",
      "--user",
      String(userId),
      "--activity",
      "7",
      "--via",
      "event-stream",
    ]);
  });
});
