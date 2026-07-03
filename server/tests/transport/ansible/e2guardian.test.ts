/**
 * Unit tests for the e2guardian filter-plan generation + push wiring (#90) —
 * the `playbook-generation` tier in `docs/testing.md`. No `ansible-playbook` is
 * spawned; the runner is an injected stub. Live behaviour is a Molecule
 * integration test tracked separately (see the issue linked from the PR).
 */
import { describe, expect, it, vi } from "vitest";

import {
  addActivityToGroup,
  addUserToGroup,
  createActivity,
  createActivityGroup,
  createClient,
  createGroupSchedule,
  createSchedule,
  createUser,
  createUserGroup,
  upsertLink,
} from "../../../src/policy/repository.js";
import {
  AnsiblePlaybookFailedError,
  AnsibleUnavailableError,
  AnsibleUnreachableError,
} from "../../../src/transport/ansible/errors.js";
import {
  buildE2guardianPlan,
  DEFAULT_PROXY_PORT,
  E2GUARDIAN_PLAYBOOK,
  pushE2guardianFiltering,
  type E2guardianPlan,
} from "../../../src/transport/ansible/e2guardian.js";
import type {
  AnsibleHost,
  AnsibleRunner,
  AnsibleRunResult,
  RunPlaybookOptions,
} from "../../../src/transport/ansible/index.js";
import type { AuditEntry, AuditSink } from "../../../src/transport/audit/index.js";
import { testDb, type TestDb } from "../../helpers/db.js";

/**
 * Link a fresh supervised user to `clientId` and return their id. `uid` is the
 * Linux uid; it is stored as the string `os_user_ref` the link model uses (#230).
 */
function addLinkedUser(
  db: TestDb,
  clientId: number,
  displayName: string,
  osUsername: string,
  uid: number,
): number {
  const userId = createUser(db, { displayName }).id;
  upsertLink(db, userId, clientId, { osUsername, osUserRef: String(uid) });
  return userId;
}

describe("buildE2guardianPlan", () => {
  it("collects a user's always-on domain denies into a deterministic filter group", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);

    const youtube = createActivity(db, { kind: "domain", matcher: "youtube.com" });
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: youtube.id,
      action: "deny",
    });

    const plan = buildE2guardianPlan(db, clientId);

    expect(plan.proxyPort).toBe(DEFAULT_PROXY_PORT);
    expect(plan.redirectPorts).toEqual([80, 443]);
    expect(plan.users).toEqual([
      {
        osUsername: "alice",
        osUserRef: "1001",
        filterGroup: 2,
        listenPort: DEFAULT_PROXY_PORT + 1,
        bannedSites: ["youtube.com"],
      },
    ]);
    db.$client.close();
  });

  it("expands a group-targeted deny to its domain members (apps ignored), deduped + sorted", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);

    const group = createActivityGroup(db, { name: "Distractions" });
    const fb = createActivity(db, { kind: "domain", matcher: "facebook.com" });
    const ig = createActivity(db, { kind: "domain", matcher: "instagram.com" });
    const steam = createActivity(db, { kind: "app", matcher: "steam" });
    addActivityToGroup(db, group.id, fb.id);
    addActivityToGroup(db, group.id, ig.id);
    addActivityToGroup(db, group.id, steam.id);

    // Plus a direct domain deny that overlaps instagram → deduped.
    const ig2 = createActivity(db, { kind: "domain", matcher: "instagram.com" });
    createSchedule(db, { userId: alice, targetKind: "group", targetId: group.id, action: "deny" });
    createSchedule(db, { userId: alice, targetKind: "activity", targetId: ig2.id, action: "deny" });

    const plan = buildE2guardianPlan(db, clientId);

    expect(plan.users[0]?.bannedSites).toEqual(["facebook.com", "instagram.com"]);
    db.$client.close();
  });

  it("ignores allow/extend rules, recurring/windowed denies, and date-scoped denies", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);
    const tiktok = createActivity(db, { kind: "domain", matcher: "tiktok.com" });
    const reddit = createActivity(db, { kind: "domain", matcher: "reddit.com" });
    const news = createActivity(db, { kind: "domain", matcher: "news.example" });

    // allow → not a filter
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: tiktok.id,
      action: "allow",
    });
    // deny but only on a recurring weekday window → time-window swap (deferred)
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: reddit.id,
      action: "deny",
      recurrenceDays: 0b0011111,
      recurrenceStartMinute: 16 * 60,
      recurrenceEndMinute: 18 * 60,
    });
    // deny but date-scoped → not always-on
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: news.id,
      action: "deny",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    });

    const plan = buildE2guardianPlan(db, clientId);
    expect(plan.users).toEqual([]);
    db.$client.close();
  });

  it("ignores an overall (null-target) deny — it is not a per-website filter", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);
    createSchedule(db, { userId: alice, targetKind: "overall", action: "deny" });

    expect(buildE2guardianPlan(db, clientId).users).toEqual([]);
    db.$client.close();
  });

  it("skips domain_group denies (named bundles owned by #178/#195)", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);
    const bundle = createActivity(db, { kind: "domain_group", matcher: "ads" });
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: bundle.id,
      action: "deny",
    });

    expect(buildE2guardianPlan(db, clientId).users).toEqual([]);
    db.$client.close();
  });

  it("omits users with nothing to block and assigns groups/ports in listClientLinks (user-id) order", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    // bob is created first (lowest user id), carol next (nothing to block), alice last.
    const bob = addLinkedUser(db, clientId, "Bob", "bob", 1002);
    addLinkedUser(db, clientId, "Carol", "carol", 1003);
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);

    const yt = createActivity(db, { kind: "domain", matcher: "youtube.com" });
    const tw = createActivity(db, { kind: "domain", matcher: "twitch.tv" });
    createSchedule(db, { userId: alice, targetKind: "activity", targetId: yt.id, action: "deny" });
    createSchedule(db, { userId: bob, targetKind: "activity", targetId: tw.id, action: "deny" });

    const plan = buildE2guardianPlan(db, clientId);

    // listClientLinks orders by user id, so bob (created first) precedes alice; carol omitted.
    expect(plan.users.map((u) => u.osUsername)).toEqual(["bob", "alice"]);
    expect(plan.users.map((u) => u.filterGroup)).toEqual([2, 3]);
    expect(plan.users.map((u) => u.listenPort)).toEqual([8081, 8082]);
    db.$client.close();
  });

  it("honours a custom proxyPort and redirectPorts", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);
    const yt = createActivity(db, { kind: "domain", matcher: "youtube.com" });
    createSchedule(db, { userId: alice, targetKind: "activity", targetId: yt.id, action: "deny" });

    const plan = buildE2guardianPlan(db, clientId, { proxyPort: 9000, redirectPorts: [80] });
    expect(plan.proxyPort).toBe(9000);
    expect(plan.redirectPorts).toEqual([80]);
    expect(plan.users[0]?.listenPort).toBe(9001);
    db.$client.close();
  });

  it("includes an inherited always-on group-schedule domain deny in the plan (#362)", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const alice = addLinkedUser(db, clientId, "Alice", "alice", 1001);

    // The deny is authored on a user-group the child belongs to, not on the child.
    const kids = createUserGroup(db, { name: "Kids" });
    addUserToGroup(db, kids.id, alice);
    const youtube = createActivity(db, { kind: "domain", matcher: "youtube.com" });
    createGroupSchedule(db, {
      userGroupId: kids.id,
      targetKind: "activity",
      targetId: youtube.id,
      action: "deny",
    });
    // Plus an own deny, to prove own + inherited denies combine (deduped + sorted).
    const tiktok = createActivity(db, { kind: "domain", matcher: "tiktok.com" });
    createSchedule(db, {
      userId: alice,
      targetKind: "activity",
      targetId: tiktok.id,
      action: "deny",
    });

    const plan = buildE2guardianPlan(db, clientId);

    expect(plan.users).toHaveLength(1);
    expect(plan.users[0]?.bannedSites).toEqual(["tiktok.com", "youtube.com"]);
    db.$client.close();
  });

  it("returns an empty plan for a client with no linked users", () => {
    const db = testDb();
    const clientId = createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    expect(buildE2guardianPlan(db, clientId).users).toEqual([]);
    db.$client.close();
  });
});

const HOST: AnsibleHost = { hostname: "mint-01.lan", sshUser: "pct-agent" };

const SAMPLE_PLAN: E2guardianPlan = {
  proxyPort: 8080,
  redirectPorts: [80, 443],
  users: [
    {
      osUsername: "alice",
      osUserRef: "1001",
      filterGroup: 2,
      listenPort: 8081,
      bannedSites: ["youtube.com"],
    },
  ],
};

/** A stub runner that records its single call and returns a canned result or throws. */
function stubRunner(behaviour: { result?: AnsibleRunResult; error?: unknown } = {}): {
  runner: AnsibleRunner;
  calls: RunPlaybookOptions[];
} {
  const calls: RunPlaybookOptions[] = [];
  const runner: AnsibleRunner = {
    runPlaybook: vi.fn(async (options: RunPlaybookOptions) => {
      calls.push(options);
      if (behaviour.error !== undefined) throw behaviour.error;
      return (
        behaviour.result ?? {
          playbook: options.playbook,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }
      );
    }),
  };
  return { runner, calls };
}

function collectingSink(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { sink: { record: (entry) => entries.push(entry) }, entries };
}

describe("pushE2guardianFiltering", () => {
  it("runs the playbook limited to the host with the plan as nested extra-vars", async () => {
    const { runner, calls } = stubRunner();

    const result = await pushE2guardianFiltering({ runner, host: HOST, plan: SAMPLE_PLAN });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.playbook).toBe(E2GUARDIAN_PLAYBOOK);
    expect(calls[0]?.hosts).toEqual([HOST]);
    expect(calls[0]?.limit).toBe(HOST.hostname);
    expect(calls[0]?.extraVars).toEqual({
      e2guardian: {
        proxyPort: 8080,
        redirectPorts: [80, 443],
        users: [
          {
            osUsername: "alice",
            osUserRef: "1001",
            filterGroup: 2,
            listenPort: 8081,
            bannedSites: ["youtube.com"],
          },
        ],
      },
    });
  });

  it("records a successful run in the audit sink", async () => {
    const { runner } = stubRunner();
    const { sink, entries } = collectingSink();
    let t = 1000;

    await pushE2guardianFiltering({
      runner,
      host: HOST,
      plan: SAMPLE_PLAN,
      sink,
      clientId: 7,
      actor: "admin",
      reason: "policy.changed",
      now: () => (t += 250),
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.outcome).toBe("ok");
    expect(entry?.exitCode).toBe(0);
    expect(entry?.signal).toBeNull();
    expect(entry?.errorMessage).toBeNull();
    expect(entry?.durationMs).toBe(250);
    expect(entry?.target).toEqual({ host: "mint-01.lan", port: 22, username: "pct-agent" });
    expect(entry?.command).toEqual([
      "ansible-playbook",
      E2GUARDIAN_PLAYBOOK,
      "--limit",
      "mint-01.lan",
    ]);
    expect(entry?.context).toEqual({ clientId: 7, actor: "admin", reason: "policy.changed" });
  });

  it("records an unreachable host and rethrows the retryable error", async () => {
    const error = new AnsibleUnreachableError(4, "stdout", "stderr");
    const { runner } = stubRunner({ error });
    const { sink, entries } = collectingSink();

    await expect(
      pushE2guardianFiltering({ runner, host: HOST, plan: SAMPLE_PLAN, sink, clientId: 7 }),
    ).rejects.toBe(error);

    expect(entries[0]?.outcome).toBe("unreachable");
    expect(entries[0]?.exitCode).toBe(4);
    expect(entries[0]?.errorMessage).toContain("unreachable");
    // un-attributed run defaults actor to omitted (sink fills `system`).
    expect(entries[0]?.context).toEqual({ clientId: 7, reason: null });
  });

  it("records a failed run as outcome=failed with the playbook exit code", async () => {
    const error = new AnsiblePlaybookFailedError(2, "out", "err");
    const { runner } = stubRunner({ error });
    const { sink, entries } = collectingSink();

    await expect(
      pushE2guardianFiltering({ runner, host: HOST, plan: SAMPLE_PLAN, sink }),
    ).rejects.toBe(error);

    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.exitCode).toBe(2);
  });

  it("records a non-exit failure (binary missing) as failed with a null exit code", async () => {
    const error = new AnsibleUnavailableError("/data/ansible/venv/bin/ansible-playbook");
    const { runner } = stubRunner({ error });
    const { sink, entries } = collectingSink();

    await expect(
      pushE2guardianFiltering({ runner, host: HOST, plan: SAMPLE_PLAN, sink }),
    ).rejects.toBe(error);

    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.exitCode).toBeNull();
  });

  it("truncates an overlong error message in the audit entry", async () => {
    const error = new Error("x".repeat(5000));
    const { runner } = stubRunner({ error });
    const { sink, entries } = collectingSink();

    await expect(
      pushE2guardianFiltering({ runner, host: HOST, plan: SAMPLE_PLAN, sink }),
    ).rejects.toBe(error);

    const message = entries[0]?.errorMessage ?? "";
    expect(message.length).toBeLessThan(5000);
    expect(message.endsWith("…")).toBe(true);
  });

  it("works without an audit sink", async () => {
    const { runner, calls } = stubRunner();
    await expect(
      pushE2guardianFiltering({ runner, host: HOST, plan: SAMPLE_PLAN }),
    ).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed plan before invoking the runner", async () => {
    const { runner, calls } = stubRunner();
    // filterGroup 1 is reserved for the permissive baseline — the schema rejects it.
    const bad: E2guardianPlan = {
      ...SAMPLE_PLAN,
      users: SAMPLE_PLAN.users.map((u) => ({ ...u, filterGroup: 1 })),
    };

    await expect(pushE2guardianFiltering({ runner, host: HOST, plan: bad })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
