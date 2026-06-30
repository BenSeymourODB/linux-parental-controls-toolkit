/**
 * Unit tests for the Linux {@link PlatformPolicyRunner} (#232) in isolation: the
 * `timekpra`-over-SSH enforcement lifted out of the executor. The runner is
 * driven directly with a hand-resolved {@link PolicyEnforcementContext} — it
 * touches no DB itself, which is the seam's point — covering the setter
 * sequence, the full-lockout allowed-hours skip + warn, and error propagation.
 *
 * Dispatch (runner *selection* by platform, the no-op branches) lives in
 * `executor.test.ts`; the registry in `platform-runner.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createBudget,
  createClient,
  createSchedule,
  createUser,
  getClient,
  listUserBudgets,
  listUserSchedules,
  type ClientRow,
} from "../../../src/policy/repository.js";
import {
  createLinuxPolicyRunner,
  type PolicyPushClient,
} from "../../../src/transport/policy-push/linux-runner.js";
import type { PolicyEnforcementContext } from "../../../src/transport/policy-push/platform-runner.js";
import { SshCommandError, SshUnreachableError } from "../../../src/transport/ssh/errors.js";
import { testDb, type TestDb } from "../../helpers/db.js";

const target = { host: "mint-01", port: 22, username: "pct-agent" } as const;

/** A recording `PolicyPushClient` capturing the setter calls in order. */
function recordingClient(behaviour?: { rejectWith?: Error }): {
  client: PolicyPushClient;
  calls: string[];
} {
  const calls: string[] = [];
  const maybeReject = async (): Promise<void> => {
    if (behaviour?.rejectWith) throw behaviour.rejectWith;
  };
  return {
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
}

/** Build a resolved enforcement context for `userId` from the store rows. */
function contextFor(db: TestDb, userId: number, client: ClientRow): PolicyEnforcementContext {
  return {
    client,
    username: "alice",
    userId,
    reason: "budget.updated",
    tz: "UTC",
    schedules: listUserSchedules(db, userId),
    budgets: listUserBudgets(db, userId),
    now: new Date("2026-06-24T12:00:00Z"),
  };
}

describe("createLinuxPolicyRunner", () => {
  let db: TestDb;

  function setup(): { userId: number; client: ClientRow } {
    db = testDb();
    const userId = createUser(db, { displayName: "Alice", tz: "UTC" }).id;
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const client = getClient(db, clientId);
    if (client === undefined) throw new Error("client not created");
    return { userId, client };
  }

  it("reports the linux platform", () => {
    const runner = createLinuxPolicyRunner({ buildClient: () => recordingClient().client });
    expect(runner.platform).toBe("linux");
  });

  it("drives the daily limit and allowed-hours setters from the resolved context", async () => {
    const { userId, client } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });

    const rec = recordingClient();
    let builtFor: string | undefined;
    const runner = createLinuxPolicyRunner({
      buildClient: (t) => {
        builtFor = t.username;
        return rec.client;
      },
    });

    await runner.enforce(contextFor(db, userId, client));

    expect(builtFor).toBe("alice");
    expect(rec.calls).toEqual([
      "setTimeLimits:7200,7200,7200,7200,7200,7200,7200",
      "setWeeklyAllowedHours:7",
    ]);
  });

  it("unmanage pushes the fully-unrestricted config, ignoring any stale rows (#253)", async () => {
    const { userId, client } = setup();
    // Leftover policy rows must not shape the unmanage push — it is always the
    // fixed unrestricted config (all-hours-every-day, so allowed-hours is sent).
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 3600 });
    createSchedule(db, { userId, targetKind: "overall", action: "deny" });

    const rec = recordingClient();
    let builtFor: string | undefined;
    const runner = createLinuxPolicyRunner({
      buildClient: (t) => {
        builtFor = t.username;
        return rec.client;
      },
    });

    await runner.unmanage({ client, username: "alice", userId, reason: "link.deleted" });

    expect(builtFor).toBe("alice");
    expect(rec.calls).toEqual([
      "setTimeLimits:86400,86400,86400,86400,86400,86400,86400",
      "setTimeLimitWeek:604800",
      "setTimeLimitMonth:2678400",
      "setWeeklyAllowedHours:7",
    ]);
  });

  it("skips the allowed-hours push and warns for a fully-denied week", async () => {
    const { userId, client } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 3600 });
    createSchedule(db, { userId, targetKind: "overall", action: "deny" });

    const rec = recordingClient();
    const warn = vi.fn();
    const runner = createLinuxPolicyRunner({ buildClient: () => rec.client, log: { warn } });

    await runner.enforce(contextFor(db, userId, client));

    expect(rec.calls).toEqual(["setTimeLimits:3600,3600,3600,3600,3600,3600,3600"]);
    expect(rec.calls).not.toContain("setWeeklyAllowedHours:7");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ clientId: client.id, userId });
  });

  it("propagates a retriable failure unchanged", async () => {
    const { userId, client } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });
    const rec = recordingClient({ rejectWith: new SshUnreachableError(target) });
    const runner = createLinuxPolicyRunner({ buildClient: () => rec.client });

    await expect(runner.enforce(contextFor(db, userId, client))).rejects.toBeInstanceOf(
      SshUnreachableError,
    );
  });

  it("propagates a non-retriable command failure unchanged", async () => {
    const { userId, client } = setup();
    createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 7200 });
    const rec = recordingClient({
      rejectWith: new SshCommandError(target, ["timekpra"], {
        stdout: "",
        stderr: "boom",
        code: 1,
        signal: null,
      }),
    });
    const runner = createLinuxPolicyRunner({ buildClient: () => rec.client });

    await expect(runner.enforce(contextFor(db, userId, client))).rejects.toBeInstanceOf(
      SshCommandError,
    );
  });
});
