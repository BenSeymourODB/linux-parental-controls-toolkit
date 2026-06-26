/**
 * Unit tests for the "Add time today" adjustment service (#257): fanning a
 * `--settimeleft` op out to a user's linked clients, the per-client
 * applied/unreachable/failed outcomes, and the targeting errors (no links / a
 * client the user isn't linked to). No SSH — the `timekpra` client is a fake.
 */
import { describe, expect, it } from "vitest";

import { createClient, createUser, upsertLink } from "../../../src/policy/repository.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import {
  adjustTimeToday,
  TimeTodayTargetError,
  type TimeTodayClient,
  type TimeTodayClientTarget,
} from "../../../src/transport/time-today/adjust.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const sshTarget = { host: "mint-01", port: 22, username: "pct-agent" } as const;

/** A recording `TimeTodayClient`; optionally rejects to exercise the outcomes. */
function recordingClient(behaviour?: { rejectWith?: Error }): {
  readonly client: TimeTodayClient;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async setTimeLeft(operation, seconds) {
        calls.push(`${operation}${seconds}`);
        if (behaviour?.rejectWith) throw behaviour.rejectWith;
      },
    },
  };
}

function unreachable(): SshUnreachableError {
  return new SshUnreachableError(sshTarget, { cause: new Error("ECONNREFUSED") });
}

function commandFailed(): SshCommandError {
  return new SshCommandError(sshTarget, ["sudo", "timekpra"], {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "no such user",
  });
}

describe("adjustTimeToday", () => {
  let db: TestDb;

  function seedUser(): number {
    db = testDb();
    return createUser(db, { displayName: "Alice", tz: "UTC" }).id;
  }

  function link(userId: number, hostname: string, osUsername: string): number {
    const clientId = createClient(db, { hostname, sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername, osUserRef: "1001" });
    return clientId;
  }

  it("applies the adjustment to every linked client and reports the calls", async () => {
    const userId = seedUser();
    const c1 = link(userId, "mint-01", "alice");
    const c2 = link(userId, "mint-02", "alice2");

    const rec = recordingClient();
    const built: TimeTodayClientTarget[] = [];
    const result = await adjustTimeToday(
      db,
      (t) => {
        built.push(t);
        return rec.client;
      },
      { userId, operation: "+", seconds: 1800 },
    );

    expect(result.results).toEqual([
      { clientId: c1, osUsername: "alice", status: "applied" },
      { clientId: c2, osUsername: "alice2", status: "applied" },
    ]);
    // One `--settimeleft +1800` per linked client, attributed to the user.
    expect(rec.calls).toEqual(["+1800", "+1800"]);
    expect(built.map((t) => ({ id: t.client.id, username: t.username, userId: t.userId }))).toEqual(
      [
        { id: c1, username: "alice", userId },
        { id: c2, username: "alice2", userId },
      ],
    );
  });

  it("restricts to a single client when clientId is given", async () => {
    const userId = seedUser();
    link(userId, "mint-01", "alice");
    const c2 = link(userId, "mint-02", "alice2");

    const rec = recordingClient();
    const result = await adjustTimeToday(db, () => rec.client, {
      userId,
      operation: "=",
      seconds: 3600,
      clientId: c2,
    });

    expect(result.results).toEqual([{ clientId: c2, osUsername: "alice2", status: "applied" }]);
    expect(rec.calls).toEqual(["=3600"]);
  });

  it("marks a client unreachable on the retriable SSH taxonomy (not queued)", async () => {
    const userId = seedUser();
    const c1 = link(userId, "mint-01", "alice");

    const rec = recordingClient({ rejectWith: unreachable() });
    const result = await adjustTimeToday(db, () => rec.client, {
      userId,
      operation: "+",
      seconds: 900,
    });

    expect(result.results[0]?.status).toBe("unreachable");
    expect(result.results[0]?.error).toMatch(/unreachable/i);
    expect(result.results[0]?.clientId).toBe(c1);
  });

  it("marks a client failed on a non-retriable command error", async () => {
    const userId = seedUser();
    link(userId, "mint-01", "alice");

    const rec = recordingClient({ rejectWith: commandFailed() });
    const result = await adjustTimeToday(db, () => rec.client, {
      userId,
      operation: "-",
      seconds: 60,
    });

    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.error).toMatch(/Remote command failed/i);
  });

  it("reports a partial fan-out (one applied, one unreachable)", async () => {
    const userId = seedUser();
    const c1 = link(userId, "mint-01", "alice");
    const c2 = link(userId, "mint-02", "alice2");

    const ok = recordingClient();
    const down = recordingClient({ rejectWith: unreachable() });
    const result = await adjustTimeToday(
      db,
      (t) => (t.client.id === c1 ? ok.client : down.client),
      { userId, operation: "+", seconds: 1800 },
    );

    expect(result.results).toEqual([
      { clientId: c1, osUsername: "alice", status: "applied" },
      expect.objectContaining({ clientId: c2, osUsername: "alice2", status: "unreachable" }),
    ]);
  });

  it("throws TimeTodayTargetError when the user has no links", async () => {
    const userId = seedUser();
    await expect(
      adjustTimeToday(db, () => recordingClient().client, {
        userId,
        operation: "+",
        seconds: 1800,
      }),
    ).rejects.toBeInstanceOf(TimeTodayTargetError);
  });

  it("throws TimeTodayTargetError when the requested client isn't linked", async () => {
    const userId = seedUser();
    link(userId, "mint-01", "alice");
    await expect(
      adjustTimeToday(db, () => recordingClient().client, {
        userId,
        operation: "+",
        seconds: 1800,
        clientId: 9999,
      }),
    ).rejects.toBeInstanceOf(TimeTodayTargetError);
  });
});
