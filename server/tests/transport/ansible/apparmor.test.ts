/**
 * Unit tests for the AppArmor per-app hard-deny plan generation + push (#92).
 *
 * Hermetic: an in-memory policy DB seeded via the repository, a fake Ansible
 * runner (records its calls / can throw a chosen transport error), and a
 * collecting audit sink. No subprocess, no live host.
 */
import { describe, expect, it, vi } from "vitest";

import type { AuditEntry, AuditSink } from "../../../src/transport/audit/index.js";
import {
  AnsiblePlaybookFailedError,
  AnsibleUnavailableError,
  AnsibleUnreachableError,
  type AnsibleRunResult,
  type AnsibleRunner,
  type RunPlaybookOptions,
} from "../../../src/transport/ansible/index.js";
import {
  APPARMOR_PLAYBOOK,
  AppArmorPlanError,
  buildAppArmorPlan,
  profileNameFor,
  pushAppArmorProfiles,
} from "../../../src/transport/ansible/apparmor.js";
import {
  addActivityToGroup,
  createActivity,
  createActivityGroup,
  createClient,
  createSchedule,
  createUser,
  upsertLink,
  type ClientRow,
} from "../../../src/policy/repository.js";
import { testDb, type TestDb } from "../../helpers/db.js";

// --- Fakes -----------------------------------------------------------------

function fakeRunner(behaviour: { result?: AnsibleRunResult; error?: unknown } = {}): {
  runner: AnsibleRunner;
  calls: RunPlaybookOptions[];
} {
  const calls: RunPlaybookOptions[] = [];
  const runner: AnsibleRunner = {
    runPlaybook(options) {
      calls.push(options);
      if (behaviour.error !== undefined) return Promise.reject(behaviour.error);
      return Promise.resolve(
        behaviour.result ?? {
          playbook: options.playbook,
          exitCode: 0,
          stdout: "PLAY RECAP ok",
          stderr: "",
        },
      );
    },
  };
  return { runner, calls };
}

function fakeAudit(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { sink: { record: (e) => entries.push(e) }, entries };
}

// --- Seeding helpers -------------------------------------------------------

function seedClient(db: TestDb, hostname = "mint-01.lan", sshUser = "pct-agent"): ClientRow {
  return createClient(db, { hostname, sshUser });
}

/** Link a fresh supervised user to a client and return the user id. */
function linkUser(db: TestDb, clientId: number, name: string, linuxUid: number): number {
  const user = createUser(db, { displayName: name });
  upsertLink(db, user.id, clientId, { linuxUsername: name.toLowerCase(), linuxUid });
  return user.id;
}

/** An always-on `deny` schedule for a user against a single activity. */
function denyActivity(db: TestDb, userId: number, activityId: number): void {
  createSchedule(db, { userId, targetKind: "activity", targetId: activityId, action: "deny" });
}

// --- profileNameFor --------------------------------------------------------

describe("profileNameFor", () => {
  it("prefixes pct. and turns an absolute path into a dotted stem", () => {
    expect(profileNameFor("/usr/bin/firefox")).toBe("pct.usr.bin.firefox");
  });

  it("strips redundant leading slashes and keeps dots, hyphens, underscores", () => {
    expect(profileNameFor("//opt/Game-Launcher/run_me")).toBe("pct.opt.Game-Launcher.run_me");
  });

  it("replaces any other character with an underscore", () => {
    expect(profileNameFor("/usr/bin/foo bar+baz")).toBe("pct.usr.bin.foo_bar_baz");
  });
});

// --- buildAppArmorPlan ------------------------------------------------------

describe("buildAppArmorPlan", () => {
  it("throws AppArmorPlanError for an unknown client", () => {
    const db = testDb();
    expect(() => buildAppArmorPlan(db, 999)).toThrow(AppArmorPlanError);
  });

  it("returns an empty plan for a client with no supervised users", () => {
    const db = testDb();
    const client = seedClient(db);
    expect(buildAppArmorPlan(db, client.id)).toEqual({
      clientId: client.id,
      hostname: client.hostname,
      denials: [],
    });
  });

  it("maps an always-on app deny (direct activity) to one profile", () => {
    const db = testDb();
    const client = seedClient(db);
    const userId = linkUser(db, client.id, "Alice", 1001);
    const app = createActivity(db, { kind: "app", matcher: "/usr/bin/steam", matchType: "exact" });
    denyActivity(db, userId, app.id);

    const plan = buildAppArmorPlan(db, client.id);

    expect(plan.denials).toEqual([
      {
        profileName: "pct.usr.bin.steam",
        executable: "/usr/bin/steam",
        blockedFor: [{ userId, linuxUid: 1001, linuxUsername: "alice" }],
      },
    ]);
  });

  it("expands a group deny to its app members and ignores non-app members", () => {
    const db = testDb();
    const client = seedClient(db);
    const userId = linkUser(db, client.id, "Bob", 1002);
    const group = createActivityGroup(db, { name: "games" });
    const app = createActivity(db, { kind: "app", matcher: "/usr/bin/minecraft" });
    const domain = createActivity(db, { kind: "domain", matcher: "twitch.tv" });
    addActivityToGroup(db, group.id, app.id);
    addActivityToGroup(db, group.id, domain.id);
    createSchedule(db, { userId, targetKind: "group", targetId: group.id, action: "deny" });

    const plan = buildAppArmorPlan(db, client.id);

    expect(plan.denials.map((d) => d.executable)).toEqual(["/usr/bin/minecraft"]);
  });

  it("unions and sorts denials across users, deduping a shared executable", () => {
    const db = testDb();
    const client = seedClient(db);
    const alice = linkUser(db, client.id, "Alice", 1001);
    const bob = linkUser(db, client.id, "Bob", 1002);
    const steam = createActivity(db, { kind: "app", matcher: "/usr/bin/steam" });
    const discord = createActivity(db, { kind: "app", matcher: "/opt/discord/Discord" });
    denyActivity(db, alice, steam.id);
    denyActivity(db, bob, steam.id); // shared
    denyActivity(db, bob, discord.id);

    const plan = buildAppArmorPlan(db, client.id);

    // Sorted ascending by executable: /opt/... before /usr/...
    expect(plan.denials.map((d) => d.executable)).toEqual([
      "/opt/discord/Discord",
      "/usr/bin/steam",
    ]);
    const steamDenial = plan.denials.find((d) => d.executable === "/usr/bin/steam");
    expect(steamDenial?.blockedFor.map((b) => b.userId)).toEqual([alice, bob]); // unioned, sorted
  });

  it("collapses a user blocking the same executable via two rules", () => {
    const db = testDb();
    const client = seedClient(db);
    const userId = linkUser(db, client.id, "Alice", 1001);
    const steam = createActivity(db, { kind: "app", matcher: "/usr/bin/steam" });
    denyActivity(db, userId, steam.id);
    denyActivity(db, userId, steam.id);

    const plan = buildAppArmorPlan(db, client.id);

    expect(plan.denials).toHaveLength(1);
    expect(plan.denials[0]?.blockedFor).toHaveLength(1);
  });

  it("omits a user who has nothing mappable to block", () => {
    const db = testDb();
    const client = seedClient(db);
    const alice = linkUser(db, client.id, "Alice", 1001);
    linkUser(db, client.id, "Bob", 1002); // Bob has no deny rules
    const steam = createActivity(db, { kind: "app", matcher: "/usr/bin/steam" });
    denyActivity(db, alice, steam.id);

    const plan = buildAppArmorPlan(db, client.id);

    expect(plan.denials).toHaveLength(1);
    expect(plan.denials[0]?.blockedFor.map((b) => b.userId)).toEqual([alice]);
  });

  it("skips allow/extend actions, overall scope, and non-deny rules", () => {
    const db = testDb();
    const client = seedClient(db);
    const userId = linkUser(db, client.id, "Alice", 1001);
    const app = createActivity(db, { kind: "app", matcher: "/usr/bin/steam" });
    createSchedule(db, { userId, targetKind: "activity", targetId: app.id, action: "allow" });
    createSchedule(db, { userId, targetKind: "activity", targetId: app.id, action: "extend" });
    createSchedule(db, { userId, targetKind: "overall", targetId: null, action: "deny" });

    expect(buildAppArmorPlan(db, client.id).denials).toEqual([]);
  });

  it("skips windowed and date-scoped denies (only always-on profiles map)", () => {
    const db = testDb();
    const client = seedClient(db);
    const userId = linkUser(db, client.id, "Alice", 1001);
    const app = createActivity(db, { kind: "app", matcher: "/usr/bin/steam" });
    // Time-windowed (minute window set).
    createSchedule(db, {
      userId,
      targetKind: "activity",
      targetId: app.id,
      action: "deny",
      recurrenceStartMinute: 540,
      recurrenceEndMinute: 1020,
    });
    // Weekday-recurring (day mask set).
    createSchedule(db, {
      userId,
      targetKind: "activity",
      targetId: app.id,
      action: "deny",
      recurrenceDays: 62,
    });
    // Date-scoped (effectiveFrom set).
    createSchedule(db, {
      userId,
      targetKind: "activity",
      targetId: app.id,
      action: "deny",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    });

    expect(buildAppArmorPlan(db, client.id).denials).toEqual([]);
  });

  it("skips app_group, non-exact, and non-absolute matchers", () => {
    const db = testDb();
    const client = seedClient(db);
    const userId = linkUser(db, client.id, "Alice", 1001);
    const bundle = createActivity(db, { kind: "app_group", matcher: "/usr/bin/games" });
    const glob = createActivity(db, { kind: "app", matcher: "/usr/bin/*", matchType: "glob" });
    const relative = createActivity(db, { kind: "app", matcher: "firefox", matchType: "exact" });
    denyActivity(db, userId, bundle.id);
    denyActivity(db, userId, glob.id);
    denyActivity(db, userId, relative.id);

    expect(buildAppArmorPlan(db, client.id).denials).toEqual([]);
  });
});

// --- pushAppArmorProfiles --------------------------------------------------

describe("pushAppArmorProfiles", () => {
  function seedOneDeny(db: TestDb): ClientRow {
    const client = seedClient(db);
    const userId = linkUser(db, client.id, "Alice", 1001);
    const app = createActivity(db, { kind: "app", matcher: "/usr/bin/steam" });
    denyActivity(db, userId, app.id);
    return client;
  }

  it("dispatches the playbook with the plan as extra-vars and a --limit", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    const { runner, calls } = fakeRunner();

    const { plan, result } = await pushAppArmorProfiles({ db, runner, clientId: client.id });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.playbook).toBe(APPARMOR_PLAYBOOK);
    expect(call?.limit).toBe(client.hostname);
    expect(call?.hosts).toEqual([{ hostname: client.hostname, sshUser: client.sshUser }]);
    expect(call?.extraVars).toEqual({ apparmor_plan: plan });
  });

  it("still dispatches an empty plan so the client reconciles stale profiles", async () => {
    const db = testDb();
    const client = seedClient(db); // no users, no denies
    const { runner, calls } = fakeRunner();

    const { plan } = await pushAppArmorProfiles({ db, runner, clientId: client.id });

    expect(plan.denials).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("records an ok audit entry with clientId, context, and durationMs", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    const { runner } = fakeRunner();
    const { sink, entries } = fakeAudit();
    const now = vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(1075);

    await pushAppArmorProfiles({
      db,
      runner,
      clientId: client.id,
      audit: sink,
      context: { actor: "admin", reason: "apparmor push" },
      now,
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.outcome).toBe("ok");
    expect(entry?.exitCode).toBe(0);
    expect(entry?.durationMs).toBe(75);
    expect(entry?.target).toEqual({ host: client.hostname, port: 22, username: client.sshUser });
    expect(entry?.context).toEqual({
      actor: "admin",
      reason: "apparmor push",
      clientId: client.id,
    });
    expect(entry?.command).toContain("ansible-playbook");
    expect(entry?.command).toContain("--limit");
  });

  it("records an unreachable audit entry and rethrows on AnsibleUnreachableError", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    const error = new AnsibleUnreachableError(4, "", "unreachable");
    const { runner } = fakeRunner({ error });
    const { sink, entries } = fakeAudit();

    await expect(
      pushAppArmorProfiles({ db, runner, clientId: client.id, audit: sink }),
    ).rejects.toBe(error);

    expect(entries[0]?.outcome).toBe("unreachable");
    expect(entries[0]?.exitCode).toBe(4);
    expect(entries[0]?.errorMessage).toContain("unreachable");
  });

  it("records a failed audit entry and rethrows on AnsiblePlaybookFailedError", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    const error = new AnsiblePlaybookFailedError(2, "task failed", "");
    const { runner } = fakeRunner({ error });
    const { sink, entries } = fakeAudit();

    await expect(
      pushAppArmorProfiles({ db, runner, clientId: client.id, audit: sink }),
    ).rejects.toBe(error);

    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.exitCode).toBe(2);
  });

  it("records a failed audit entry with a null exit code when the binary is missing", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    const error = new AnsibleUnavailableError("/data/ansible/venv/bin/ansible-playbook");
    const { runner } = fakeRunner({ error });
    const { sink, entries } = fakeAudit();

    await expect(
      pushAppArmorProfiles({ db, runner, clientId: client.id, audit: sink }),
    ).rejects.toBe(error);

    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.exitCode).toBeNull();
  });

  it("truncates a very long error message in the audit entry", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    // A long error `detail` produces a long `.message`, which is what we record.
    const error = new AnsiblePlaybookFailedError(null, "", "", "x".repeat(900));
    const { runner } = fakeRunner({ error });
    const { sink, entries } = fakeAudit();

    await expect(
      pushAppArmorProfiles({ db, runner, clientId: client.id, audit: sink }),
    ).rejects.toBe(error);

    const message = entries[0]?.errorMessage ?? "";
    expect(message.length).toBeLessThanOrEqual(501); // 500 + the ellipsis
    expect(message.endsWith("…")).toBe(true);
  });

  it("classifies a non-Error rejection as failed with a null exit code", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    const { runner } = fakeRunner({ error: "boom" });
    const { sink, entries } = fakeAudit();

    await expect(
      pushAppArmorProfiles({ db, runner, clientId: client.id, audit: sink }),
    ).rejects.toBe("boom");

    expect(entries[0]?.outcome).toBe("failed");
    expect(entries[0]?.exitCode).toBeNull();
    expect(entries[0]?.errorMessage).toBe("boom");
  });

  it("works without an audit sink (no-op recording)", async () => {
    const db = testDb();
    const client = seedOneDeny(db);
    const { runner, calls } = fakeRunner();

    await expect(pushAppArmorProfiles({ db, runner, clientId: client.id })).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("rejects with AppArmorPlanError before running for an unknown client", async () => {
    const db = testDb();
    const { runner, calls } = fakeRunner();
    const { sink, entries } = fakeAudit();

    await expect(
      pushAppArmorProfiles({ db, runner, clientId: 999, audit: sink }),
    ).rejects.toBeInstanceOf(AppArmorPlanError);

    expect(calls).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });
});
