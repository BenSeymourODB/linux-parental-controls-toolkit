/**
 * Unit tests for the offline-queue variant of "Add time today" (#274): when
 * `AdjustTimeTodayOptions` is supplied and a client is unreachable, the
 * adjustment is durably queued (status `queued`) as a `timekpr.time-today`
 * action — a delta deferred (null target), a `=` resolved up front — rather than
 * reported as a bare `unreachable`. A non-retriable failure is still `failed`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClient, createUser, upsertLink } from "../../../src/policy/repository.js";
import { listForClient } from "../../../src/transport/queue/repository.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import { adjustTimeToday, type TimeTodayClient } from "../../../src/transport/time-today/adjust.js";
import { TIME_TODAY_KIND } from "../../../src/transport/time-today/queued.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const sshTarget = { host: "mint-01", port: 22, username: "pct-agent" } as const;
const NOW = new Date("2026-06-23T12:00:00.000Z");
const OPTIONS = { defaultTz: "UTC", now: () => NOW };

function rejectingClient(error: Error): TimeTodayClient {
  return {
    setTimeLeft() {
      return Promise.reject(error);
    },
  };
}

describe("adjustTimeToday (offline-queue variant)", () => {
  let db: TestDb;
  let userId: number;
  let clientId: number;

  beforeEach(() => {
    db = testDb();
    userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
  });
  afterEach(() => {
    db.$client.close();
  });

  it("queues a delta for an unreachable client (deferred target) and reports `queued`", async () => {
    const error = new SshUnreachableError(sshTarget, { cause: new Error("ECONNREFUSED") });
    const result = await adjustTimeToday(
      db,
      () => rejectingClient(error),
      { userId, operation: "+", seconds: 1800 },
      OPTIONS,
    );

    expect(result.results).toEqual([{ clientId, osUsername: "alice", status: "queued" }]);

    const [row] = listForClient(db, clientId);
    expect(row?.kind).toBe(TIME_TODAY_KIND);
    expect(row?.payload).toMatchObject({
      userId,
      osUsername: "alice",
      targetDate: "2026-06-23",
      operation: "+",
      seconds: 1800,
      resolvedTargetSeconds: null, // deferred until reconnect
    });
  });

  it("resolves a `=` set's absolute target up front when queued", async () => {
    const error = new SshUnreachableError(sshTarget, { cause: new Error("timeout") });
    await adjustTimeToday(
      db,
      () => rejectingClient(error),
      { userId, operation: "=", seconds: 3600 },
      OPTIONS,
    );

    const [row] = listForClient(db, clientId);
    expect(row?.payload).toMatchObject({ operation: "=", resolvedTargetSeconds: 3600 });
  });

  it("does not queue a non-retriable failure (still `failed`)", async () => {
    const error = new SshCommandError(sshTarget, ["timekpra"], {
      code: 1,
      signal: null,
      stdout: "",
      stderr: "no such user",
    });
    const result = await adjustTimeToday(
      db,
      () => rejectingClient(error),
      { userId, operation: "+", seconds: 900 },
      OPTIONS,
    );

    expect(result.results[0]?.status).toBe("failed");
    expect(listForClient(db, clientId)).toEqual([]);
  });

  it("without options, an unreachable client is reported (not queued)", async () => {
    const error = new SshUnreachableError(sshTarget, { cause: new Error("ECONNREFUSED") });
    const result = await adjustTimeToday(db, () => rejectingClient(error), {
      userId,
      operation: "+",
      seconds: 1800,
    });

    expect(result.results[0]?.status).toBe("unreachable");
    expect(listForClient(db, clientId)).toEqual([]);
  });
});
