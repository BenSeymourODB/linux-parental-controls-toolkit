/**
 * Unit tests for the account/device-core repository (#51) against a hermetic
 * in-memory policy DB (`testDb`, foreign_keys ON). Covers CRUD round-trips,
 * ON DELETE CASCADE, link upsert, and the unique-violation signal the route
 * layer maps to 409.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as repo from "../../src/policy/repository.js";
import { ReorderMismatchError } from "../../src/policy/schedule-precedence.js";
import { clients } from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("policy repository — users", () => {
  let db: TestDb;
  beforeEach(() => {
    db = testDb();
  });
  afterEach(() => {
    db.$client.close();
  });

  it("creates, reads, lists, updates, and deletes a user", () => {
    const created = repo.createUser(db, { displayName: "Alice", tz: "Europe/London" });
    expect(created.id).toBeGreaterThan(0);
    expect(created.displayName).toBe("Alice");
    expect(created.tz).toBe("Europe/London");
    expect(created.createdAt).toBeInstanceOf(Date);

    expect(repo.getUser(db, created.id)).toEqual(created);
    expect(repo.listUsers(db)).toEqual([created]);

    const updated = repo.updateUser(db, created.id, { displayName: "Alice B." });
    expect(updated?.displayName).toBe("Alice B.");
    expect(updated?.tz).toBe("Europe/London");

    // tz: null clears the override; displayName stays.
    const cleared = repo.updateUser(db, created.id, { tz: null });
    expect(cleared?.tz).toBeNull();
    expect(cleared?.displayName).toBe("Alice B.");

    expect(repo.deleteUser(db, created.id)).toBe(true);
    expect(repo.getUser(db, created.id)).toBeUndefined();
  });

  it("defaults tz to null when omitted", () => {
    const created = repo.createUser(db, { displayName: "Bob" });
    expect(created.tz).toBeNull();
  });

  it("returns undefined / false for a missing user", () => {
    expect(repo.getUser(db, 999)).toBeUndefined();
    expect(repo.updateUser(db, 999, { displayName: "x" })).toBeUndefined();
    expect(repo.deleteUser(db, 999)).toBe(false);
  });
});

describe("policy repository — clients", () => {
  let db: TestDb;
  beforeEach(() => {
    db = testDb();
  });
  afterEach(() => {
    db.$client.close();
  });

  it("creates, reads, updates, and deletes a client", () => {
    const created = repo.createClient(db, { hostname: "mint-01", sshUser: "pct-agent" });
    expect(created.hostname).toBe("mint-01");
    expect(created.lastSeen).toBeNull();
    expect(created.enrolledAt).toBeInstanceOf(Date);

    expect(repo.getClient(db, created.id)).toEqual(created);
    expect(repo.listClients(db)).toEqual([created]);

    const updated = repo.updateClient(db, created.id, { hostname: "mint-renamed" });
    expect(updated?.hostname).toBe("mint-renamed");

    expect(repo.deleteClient(db, created.id)).toBe(true);
    expect(repo.getClient(db, created.id)).toBeUndefined();
  });

  it("throws a unique violation on a duplicate hostname", () => {
    repo.createClient(db, { hostname: "dup", sshUser: "pct-agent" });
    let caught: unknown;
    try {
      repo.createClient(db, { hostname: "dup", sshUser: "pct-agent" });
    } catch (err) {
      caught = err;
    }
    expect(repo.isUniqueViolation(caught)).toBe(true);
  });

  it("returns undefined / false for a missing client", () => {
    expect(repo.getClient(db, 999)).toBeUndefined();
    expect(repo.updateClient(db, 999, { sshUser: "x" })).toBeUndefined();
    expect(repo.deleteClient(db, 999)).toBe(false);
  });

  it("finds a client by its bearer-token hash, and not by an unknown one", () => {
    // bearer_token_hash is set only by the enrol path, so insert it directly.
    const id = db
      .insert(clients)
      .values({ hostname: "mint-bt", sshUser: "pct-agent", bearerTokenHash: "deadbeef" })
      .returning()
      .get().id;

    expect(repo.findClientByBearerTokenHash(db, "deadbeef")?.id).toBe(id);
    expect(repo.findClientByBearerTokenHash(db, "nope")).toBeUndefined();
  });

  it("touches last_seen (and is a no-op for a missing client)", () => {
    const id = repo.createClient(db, { hostname: "mint-ls", sshUser: "pct-agent" }).id;
    expect(repo.getClient(db, id)?.lastSeen).toBeNull();

    const at = new Date("2026-06-19T12:00:00.000Z");
    repo.touchClientLastSeen(db, id, at);
    expect(repo.getClient(db, id)?.lastSeen).toEqual(at);

    // No throw, no row touched.
    repo.touchClientLastSeen(db, 999, at);
    expect(repo.listClients(db)).toHaveLength(1);
  });

  it("records the reported agent version + versions_reported_at (#165 heartbeat)", () => {
    const id = repo.createClient(db, { hostname: "mint-av", sshUser: "pct-agent" }).id;
    expect(repo.getClient(db, id)?.agentVersion).toBeNull();

    const at = new Date("2026-06-23T09:00:00.000Z");
    repo.recordClientAgentVersion(db, id, "1.4.2", at);
    const row = repo.getClient(db, id);
    expect(row?.agentVersion).toBe("1.4.2");
    expect(row?.versionsReportedAt).toEqual(at);

    // No throw, no row touched for a missing client.
    repo.recordClientAgentVersion(db, 999, "9.9.9", at);
    expect(repo.listClients(db)).toHaveLength(1);
  });

  it("sets and clears update_required (and is a no-op for a missing client)", () => {
    const id = repo.createClient(db, { hostname: "mint-ur", sshUser: "pct-agent" }).id;
    expect(repo.getClient(db, id)?.updateRequired).toBe(false);

    repo.setClientUpdateRequired(db, id, true);
    expect(repo.getClient(db, id)?.updateRequired).toBe(true);

    repo.setClientUpdateRequired(db, id, false);
    expect(repo.getClient(db, id)?.updateRequired).toBe(false);

    repo.setClientUpdateRequired(db, 999, true);
    expect(repo.listClients(db)).toHaveLength(1);
  });
});

describe("policy repository — user/client links", () => {
  let db: TestDb;
  let userId: number;
  let clientId: number;
  beforeEach(() => {
    db = testDb();
    userId = repo.createUser(db, { displayName: "Alice" }).id;
    clientId = repo.createClient(db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("upserts a link idempotently and lists it", () => {
    const link = repo.upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    expect(link).toEqual({ userId, clientId, osUsername: "alice", osUserRef: "1001" });
    expect(repo.listUserLinks(db, userId)).toEqual([link]);

    // Re-upsert replaces the link's attributes rather than inserting a second.
    const replaced = repo.upsertLink(db, userId, clientId, {
      osUsername: "alice2",
      osUserRef: "1002",
    });
    expect(replaced.osUserRef).toBe("1002");
    expect(repo.listUserLinks(db, userId)).toEqual([replaced]);
  });

  it("listClientLinks returns a client's links ascending by user id, isolated per client", () => {
    const bob = repo.createUser(db, { displayName: "Bob" }).id;
    const otherClient = repo.createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
    const aliceLink = repo.upsertLink(db, userId, clientId, {
      osUsername: "alice",
      osUserRef: "1001",
    });
    const bobLink = repo.upsertLink(db, bob, clientId, { osUsername: "bob", osUserRef: "1002" });
    repo.upsertLink(db, userId, otherClient, { osUsername: "alice", osUserRef: "1001" });

    expect(repo.listClientLinks(db, clientId)).toEqual([aliceLink, bobLink]);
    expect(repo.listClientLinks(db, 999)).toEqual([]);
  });

  it("rejects a duplicate (client, os_user_ref) for a different user with a unique violation", () => {
    const otherUser = repo.createUser(db, { displayName: "Bob" }).id;
    repo.upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    let caught: unknown;
    try {
      repo.upsertLink(db, otherUser, clientId, { osUsername: "bob", osUserRef: "1001" });
    } catch (err) {
      caught = err;
    }
    expect(repo.isUniqueViolation(caught)).toBe(true);
  });

  it("cascades link removal when the user is deleted", () => {
    repo.upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    expect(repo.deleteUser(db, userId)).toBe(true);
    expect(repo.listUserLinks(db, userId)).toEqual([]);
  });

  it("cascades link removal when the client is deleted", () => {
    repo.upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    expect(repo.deleteClient(db, clientId)).toBe(true);
    expect(repo.listUserLinks(db, userId)).toEqual([]);
  });

  it("deleteLink returns the removed row, then undefined when there is none", () => {
    repo.upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    const removed = repo.deleteLink(db, userId, clientId);
    // The removed row carries the OS account name the unlink push (#253)
    // needs, since the link has now cascaded away.
    expect(removed).toMatchObject({ userId, clientId, osUsername: "alice", osUserRef: "1001" });
    expect(repo.deleteLink(db, userId, clientId)).toBeUndefined();
  });

  it("listUserClientIds returns the linked client ids ascending, [] when none", () => {
    expect(repo.listUserClientIds(db, userId)).toEqual([]);
    const second = repo.createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
    repo.upsertLink(db, userId, second, { osUsername: "alice", osUserRef: "1002" });
    repo.upsertLink(db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    expect(repo.listUserClientIds(db, userId)).toEqual([clientId, second].sort((a, b) => a - b));
  });
});

describe("isUniqueViolation", () => {
  it("is false for non-constraint values", () => {
    expect(repo.isUniqueViolation(null)).toBe(false);
    expect(repo.isUniqueViolation(undefined)).toBe(false);
    expect(repo.isUniqueViolation("SQLITE_CONSTRAINT_UNIQUE")).toBe(false);
    expect(repo.isUniqueViolation(new Error("boom"))).toBe(false);
    expect(repo.isUniqueViolation({ code: "SQLITE_BUSY" })).toBe(false);
  });

  it("is true for UNIQUE and PRIMARYKEY constraint codes", () => {
    expect(repo.isUniqueViolation({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(repo.isUniqueViolation({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" })).toBe(true);
  });
});

describe("isCheckViolation", () => {
  it("is false for non-CHECK values", () => {
    expect(repo.isCheckViolation(null)).toBe(false);
    expect(repo.isCheckViolation(new Error("boom"))).toBe(false);
    expect(repo.isCheckViolation({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(false);
  });

  it("is true for the CHECK constraint code", () => {
    expect(repo.isCheckViolation({ code: "SQLITE_CONSTRAINT_CHECK" })).toBe(true);
  });
});

describe("policy repository — activities & groups", () => {
  let db: TestDb;
  beforeEach(() => {
    db = testDb();
  });
  afterEach(() => {
    db.$client.close();
  });

  it("creates, reads, lists, updates, and deletes an activity", () => {
    const created = repo.createActivity(db, { kind: "app", matcher: "firefox" });
    expect(created.id).toBeGreaterThan(0);
    expect(created.kind).toBe("app");
    // match_type defaults to the v1 'exact' when not supplied (ADR 0006).
    expect(created.matchType).toBe("exact");

    expect(repo.getActivity(db, created.id)).toEqual(created);
    expect(repo.listActivities(db)).toEqual([created]);

    const updated = repo.updateActivity(db, created.id, { matcher: "firefox-esr" });
    expect(updated?.matcher).toBe("firefox-esr");
    expect(updated?.kind).toBe("app");

    expect(repo.deleteActivity(db, created.id)).toBe(true);
    expect(repo.getActivity(db, created.id)).toBeUndefined();
    expect(repo.deleteActivity(db, created.id)).toBe(false);
  });

  it("persists an explicit match_type and patches it (#178)", () => {
    const created = repo.createActivity(db, {
      kind: "app_group",
      matcher: "(chrome|firefox)",
      matchType: "regex",
    });
    expect(created.matchType).toBe("regex");
    expect(repo.getActivity(db, created.id)?.matchType).toBe("regex");

    const updated = repo.updateActivity(db, created.id, { matchType: "substring" });
    expect(updated?.matchType).toBe("substring");
    // The matcher is untouched by a match-type-only patch.
    expect(updated?.matcher).toBe("(chrome|firefox)");
  });

  it("returns undefined for a missing activity update", () => {
    expect(repo.updateActivity(db, 999, { matcher: "x" })).toBeUndefined();
  });

  it("creates a group and surfaces a duplicate name as a unique violation", () => {
    const group = repo.createActivityGroup(db, { name: "Social" });
    expect(group.name).toBe("Social");
    expect(repo.listActivityGroups(db)).toEqual([group]);

    let caught: unknown;
    try {
      repo.createActivityGroup(db, { name: "Social" });
    } catch (err) {
      caught = err;
    }
    expect(repo.isUniqueViolation(caught)).toBe(true);
  });

  it("renames a group and surfaces a missing one as undefined", () => {
    const group = repo.createActivityGroup(db, { name: "Social" });
    const renamed = repo.updateActivityGroup(db, group.id, { name: "Socials" });
    expect(renamed?.name).toBe("Socials");
    expect(repo.updateActivityGroup(db, 999, { name: "x" })).toBeUndefined();
  });

  it("manages membership idempotently and cascades on delete", () => {
    const group = repo.createActivityGroup(db, { name: "Social" });
    const fb = repo.createActivity(db, { kind: "domain", matcher: "facebook.com" });
    const ig = repo.createActivity(db, { kind: "domain", matcher: "instagram.com" });

    repo.addActivityToGroup(db, group.id, fb.id);
    repo.addActivityToGroup(db, group.id, fb.id); // idempotent — no throw, no dup
    repo.addActivityToGroup(db, group.id, ig.id);

    expect(repo.isGroupMember(db, group.id, fb.id)).toBe(true);
    expect(repo.listGroupActivities(db, group.id)).toEqual([fb, ig]);

    expect(repo.removeActivityFromGroup(db, group.id, fb.id)).toBe(true);
    expect(repo.removeActivityFromGroup(db, group.id, fb.id)).toBe(false);
    expect(repo.isGroupMember(db, group.id, fb.id)).toBe(false);

    // Deleting the group cascades its memberships away.
    repo.deleteActivityGroup(db, group.id);
    expect(repo.listGroupActivities(db, group.id)).toEqual([]);
    // The activity itself survives the group deletion.
    expect(repo.getActivity(db, ig.id)).toBeDefined();
  });

  it("cascades membership when the activity is deleted", () => {
    const group = repo.createActivityGroup(db, { name: "Games" });
    const steam = repo.createActivity(db, { kind: "app", matcher: "steam" });
    repo.addActivityToGroup(db, group.id, steam.id);
    repo.deleteActivity(db, steam.id);
    expect(repo.listGroupActivities(db, group.id)).toEqual([]);
  });
});

describe("policy repository — user groups & membership", () => {
  let db: TestDb;
  beforeEach(() => {
    db = testDb();
  });
  afterEach(() => {
    db.$client.close();
  });

  it("creates, reads, lists, renames, and deletes a user group", () => {
    const created = repo.createUserGroup(db, { name: "Kids" });
    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe("Kids");
    expect(created.createdAt).toBeInstanceOf(Date);

    expect(repo.getUserGroup(db, created.id)).toEqual(created);
    expect(repo.listUserGroups(db)).toEqual([created]);

    const renamed = repo.updateUserGroup(db, created.id, { name: "Children" });
    expect(renamed?.name).toBe("Children");

    expect(repo.deleteUserGroup(db, created.id)).toBe(true);
    expect(repo.getUserGroup(db, created.id)).toBeUndefined();
    expect(repo.deleteUserGroup(db, created.id)).toBe(false);
  });

  it("surfaces a duplicate group name as a unique violation", () => {
    repo.createUserGroup(db, { name: "Kids" });
    let caught: unknown;
    try {
      repo.createUserGroup(db, { name: "Kids" });
    } catch (err) {
      caught = err;
    }
    expect(repo.isUniqueViolation(caught)).toBe(true);
  });

  it("returns undefined for a missing group update", () => {
    expect(repo.updateUserGroup(db, 999, { name: "x" })).toBeUndefined();
  });

  it("manages multi-group membership idempotently from both directions", () => {
    const kids = repo.createUserGroup(db, { name: "Kids" });
    const teens = repo.createUserGroup(db, { name: "Teens" });
    const alice = repo.createUser(db, { displayName: "Alice" });
    const bob = repo.createUser(db, { displayName: "Bob" });

    repo.addUserToGroup(db, kids.id, alice.id);
    repo.addUserToGroup(db, kids.id, alice.id); // idempotent — no throw, no dup
    repo.addUserToGroup(db, kids.id, bob.id);
    // A user belongs to ≥0 groups: Alice is in both Kids and Teens.
    repo.addUserToGroup(db, teens.id, alice.id);

    expect(repo.isUserGroupMember(db, kids.id, alice.id)).toBe(true);
    expect(repo.listGroupMembers(db, kids.id)).toEqual([alice, bob]);
    expect(repo.listUserGroupsForUser(db, alice.id)).toEqual([kids, teens]);
    expect(repo.listUserGroupsForUser(db, bob.id)).toEqual([kids]);

    expect(repo.removeUserFromGroup(db, kids.id, alice.id)).toBe(true);
    expect(repo.removeUserFromGroup(db, kids.id, alice.id)).toBe(false);
    expect(repo.isUserGroupMember(db, kids.id, alice.id)).toBe(false);
    expect(repo.listUserGroupsForUser(db, alice.id)).toEqual([teens]);
  });

  it("cascades membership away when the group is deleted", () => {
    const kids = repo.createUserGroup(db, { name: "Kids" });
    const alice = repo.createUser(db, { displayName: "Alice" });
    repo.addUserToGroup(db, kids.id, alice.id);

    repo.deleteUserGroup(db, kids.id);
    expect(repo.listGroupMembers(db, kids.id)).toEqual([]);
    // The user itself survives the group deletion.
    expect(repo.getUser(db, alice.id)).toBeDefined();
    expect(repo.listUserGroupsForUser(db, alice.id)).toEqual([]);
  });

  it("cascades membership away when the user is deleted", () => {
    const kids = repo.createUserGroup(db, { name: "Kids" });
    const alice = repo.createUser(db, { displayName: "Alice" });
    repo.addUserToGroup(db, kids.id, alice.id);

    repo.deleteUser(db, alice.id);
    expect(repo.listGroupMembers(db, kids.id)).toEqual([]);
    // The group itself survives the member deletion.
    expect(repo.getUserGroup(db, kids.id)).toBeDefined();
  });
});

describe("policy repository — budgets", () => {
  let db: TestDb;
  let userId: number;
  beforeEach(() => {
    db = testDb();
    userId = repo.createUser(db, { displayName: "Alice" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("creates, reads, lists (all + per-user), updates, and deletes", () => {
    const overall = repo.createBudget(db, {
      userId,
      scope: "overall",
      window: "daily",
      secondsAllowed: 7200,
    });
    expect(overall.targetId).toBeNull();
    expect(repo.getBudget(db, overall.id)).toEqual(overall);
    expect(repo.listBudgets(db)).toEqual([overall]);
    expect(repo.listUserBudgets(db, userId)).toEqual([overall]);
    expect(repo.listUserBudgets(db, 999)).toEqual([]);

    const updated = repo.updateBudget(db, overall.id, { secondsAllowed: 3600 });
    expect(updated?.secondsAllowed).toBe(3600);

    expect(repo.deleteBudget(db, overall.id)).toBe(true);
    expect(repo.deleteBudget(db, overall.id)).toBe(false);
  });

  it("stores an activity-scoped budget with its target", () => {
    const activity = repo.createActivity(db, { kind: "app", matcher: "steam" });
    const row = repo.createBudget(db, {
      userId,
      scope: "activity",
      targetId: activity.id,
      window: "weekly",
      secondsAllowed: 3600,
    });
    expect(row.scope).toBe("activity");
    expect(row.targetId).toBe(activity.id);
  });

  it("cascades budgets when the user is deleted", () => {
    repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: 1 });
    repo.deleteUser(db, userId);
    expect(repo.listBudgets(db)).toEqual([]);
  });

  it("rejects a negative allowance at the storage CHECK", () => {
    let caught: unknown;
    try {
      repo.createBudget(db, { userId, scope: "overall", window: "daily", secondsAllowed: -1 });
    } catch (err) {
      caught = err;
    }
    expect(repo.isCheckViolation(caught)).toBe(true);
  });

  it("rejects an incoherent target at the storage CHECK", () => {
    let caught: unknown;
    try {
      // overall scope must not carry a target_id.
      repo.createBudget(db, {
        userId,
        scope: "overall",
        targetId: 5,
        window: "daily",
        secondsAllowed: 1,
      });
    } catch (err) {
      caught = err;
    }
    expect(repo.isCheckViolation(caught)).toBe(true);
  });
});

describe("policy repository — schedules & exceptions", () => {
  let db: TestDb;
  let userId: number;
  beforeEach(() => {
    db = testDb();
    userId = repo.createUser(db, { displayName: "Alice" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("stores the always-on degenerate schedule (all recurrence null)", () => {
    const row = repo.createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "deny",
    });
    expect(row.recurrenceDays).toBeNull();
    expect(row.recurrenceStartMinute).toBeNull();
    expect(row.effectiveFrom).toBeNull();
    expect(row.ordinal).toBe(0); // column default
  });

  it("stores a recurring window and orders by (ordinal, id)", () => {
    const second = repo.createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      recurrenceDays: 0b0011111, // Mon–Fri
      recurrenceStartMinute: 9 * 60,
      recurrenceEndMinute: 17 * 60,
      ordinal: 5,
    });
    const first = repo.createSchedule(db, {
      userId,
      targetKind: "overall",
      action: "deny",
      ordinal: 1,
    });
    expect(repo.listUserSchedules(db, userId).map((r) => r.id)).toEqual([first.id, second.id]);
    expect(repo.listSchedules(db).map((r) => r.id)).toEqual(
      [first.id, second.id].sort((a, b) => a - b),
    );

    const updated = repo.updateSchedule(db, second.id, { ordinal: 0 });
    expect(updated?.ordinal).toBe(0);
    expect(repo.deleteSchedule(db, second.id)).toBe(true);
    expect(repo.deleteSchedule(db, second.id)).toBe(false);
  });

  it("reorders a user's schedules to dense 0..n-1 ordinals in the new order", () => {
    const a = repo.createSchedule(db, { userId, targetKind: "overall", action: "allow" });
    const b = repo.createSchedule(db, { userId, targetKind: "overall", action: "deny" });
    const c = repo.createSchedule(db, { userId, targetKind: "overall", action: "extend" });

    const reordered = repo.reorderUserSchedules(db, userId, [c.id, a.id, b.id]);

    // Returned in the requested order with dense, gap-free ordinals.
    expect(reordered.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
    expect(reordered.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    // Persisted: a fresh evaluation-order read agrees.
    expect(repo.listUserSchedules(db, userId).map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  it("rejects a reorder whose ids are not a permutation of the user's schedules", () => {
    const a = repo.createSchedule(db, { userId, targetKind: "overall", action: "allow" });
    const b = repo.createSchedule(db, { userId, targetKind: "overall", action: "deny" });

    // Missing an id, an unknown id, and a duplicate each throw — and nothing is
    // written, so the original order is intact.
    expect(() => repo.reorderUserSchedules(db, userId, [a.id])).toThrow(ReorderMismatchError);
    expect(() => repo.reorderUserSchedules(db, userId, [a.id, 9999])).toThrow(ReorderMismatchError);
    expect(() => repo.reorderUserSchedules(db, userId, [a.id, a.id])).toThrow(ReorderMismatchError);
    expect(repo.listUserSchedules(db, userId).map((r) => r.ordinal)).toEqual([
      a.ordinal,
      b.ordinal,
    ]);
  });

  it("rejects a half-open minute pair at the storage CHECK", () => {
    let caught: unknown;
    try {
      repo.createSchedule(db, {
        userId,
        targetKind: "overall",
        action: "allow",
        recurrenceStartMinute: 540, // start without end
      });
    } catch (err) {
      caught = err;
    }
    expect(repo.isCheckViolation(caught)).toBe(true);
  });

  it("creates an exception with a pre-schedule window and orders by expiry", () => {
    const later = repo.createException(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      expiresAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    const sooner = repo.createException(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-07-01T12:00:00.000Z"),
    });
    expect(sooner.effectiveFrom).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(repo.listUserExceptions(db, userId).map((r) => r.id)).toEqual([sooner.id, later.id]);
    expect(repo.listExceptions(db).map((r) => r.id)).toEqual(
      [sooner.id, later.id].sort((a, b) => a - b),
    );

    expect(repo.deleteException(db, sooner.id)).toBe(true);
    expect(repo.deleteException(db, sooner.id)).toBe(false);
  });

  it("rejects effectiveFrom >= expiresAt at the storage CHECK", () => {
    let caught: unknown;
    try {
      repo.createException(db, {
        userId,
        targetKind: "overall",
        action: "allow",
        effectiveFrom: new Date("2026-07-02T00:00:00.000Z"),
        expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      });
    } catch (err) {
      caught = err;
    }
    expect(repo.isCheckViolation(caught)).toBe(true);
  });

  it("cascades schedules and exceptions when the user is deleted", () => {
    repo.createSchedule(db, { userId, targetKind: "overall", action: "deny" });
    repo.createException(db, {
      userId,
      targetKind: "overall",
      action: "allow",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    repo.deleteUser(db, userId);
    expect(repo.listSchedules(db)).toEqual([]);
    expect(repo.listExceptions(db)).toEqual([]);
  });
});

describe("policy repository — notification policies (#104)", () => {
  let db: TestDb;
  let userId: number;
  beforeEach(() => {
    db = testDb();
    userId = repo.createUser(db, { displayName: "Alice" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("returns undefined / false when no policy is persisted", () => {
    expect(repo.getNotificationPolicy(db, userId)).toBeUndefined();
    expect(repo.deleteNotificationPolicy(db, userId)).toBe(false);
  });

  it("inserts with the documented column defaults for omitted fields", () => {
    const row = repo.upsertNotificationPolicy(db, userId, { enabled: false });
    expect(row.userId).toBe(userId);
    expect(row.enabled).toBe(false);
    // The rest fall to the column defaults.
    expect(row.soundProfile).toBe("subtle");
    expect(row.graceSeconds).toBe(15);
    expect(row.cadenceOverridesJson).toBeNull();
    expect(repo.getNotificationPolicy(db, userId)).toEqual(row);
  });

  it("upserts idempotently on the user_id PK, updating only provided fields", () => {
    repo.upsertNotificationPolicy(db, userId, {
      soundProfile: "prominent",
      graceSeconds: 30,
      cadenceOverrides: { homework: { suppressSub5: true } },
    });
    // A second upsert changes only graceSeconds; the rest stay put.
    const updated = repo.upsertNotificationPolicy(db, userId, { graceSeconds: 0 });
    expect(updated.graceSeconds).toBe(0);
    expect(updated.soundProfile).toBe("prominent");
    expect(updated.cadenceOverridesJson).toEqual({ homework: { suppressSub5: true } });
    // Still exactly one row for the user.
    expect(repo.getNotificationPolicy(db, userId)).toEqual(updated);
  });

  it("clears cadence overrides back to null when passed null", () => {
    repo.upsertNotificationPolicy(db, userId, { cadenceOverrides: { a: 1 } });
    const cleared = repo.upsertNotificationPolicy(db, userId, { cadenceOverrides: null });
    expect(cleared.cadenceOverridesJson).toBeNull();
  });

  it("deletes a persisted policy and cascades when the user is removed", () => {
    repo.upsertNotificationPolicy(db, userId, { enabled: false });
    expect(repo.deleteNotificationPolicy(db, userId)).toBe(true);
    expect(repo.getNotificationPolicy(db, userId)).toBeUndefined();

    repo.upsertNotificationPolicy(db, userId, { enabled: false });
    repo.deleteUser(db, userId);
    expect(repo.getNotificationPolicy(db, userId)).toBeUndefined();
  });
});

describe("policy repository — group schedules & exceptions (#182)", () => {
  let db: TestDb;
  let groupId: number;
  beforeEach(() => {
    db = testDb();
    groupId = repo.createUserGroup(db, { name: "Kids" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("creates a group schedule, ordering by (ordinal, id)", () => {
    const second = repo.createGroupSchedule(db, {
      userGroupId: groupId,
      targetKind: "overall",
      action: "allow",
      recurrenceDays: 0b0011111,
      recurrenceStartMinute: 9 * 60,
      recurrenceEndMinute: 17 * 60,
      ordinal: 5,
    });
    const first = repo.createGroupSchedule(db, {
      userGroupId: groupId,
      targetKind: "overall",
      action: "deny",
      ordinal: 1,
    });
    expect(first.ordinal).toBe(1);
    expect(repo.listGroupSchedules(db, groupId).map((r) => r.id)).toEqual([first.id, second.id]);
    expect(repo.getGroupSchedule(db, second.id)?.action).toBe("allow");

    const updated = repo.updateGroupSchedule(db, second.id, { ordinal: 0 });
    expect(updated?.ordinal).toBe(0);
    expect(repo.deleteGroupSchedule(db, second.id)).toBe(true);
    expect(repo.deleteGroupSchedule(db, second.id)).toBe(false);
  });

  it("defaults recurrence to the always-on degenerate and ordinal to 0", () => {
    const row = repo.createGroupSchedule(db, {
      userGroupId: groupId,
      targetKind: "overall",
      action: "deny",
    });
    expect(row.recurrenceDays).toBeNull();
    expect(row.effectiveFrom).toBeNull();
    expect(row.ordinal).toBe(0);
  });

  it("rejects a half-open minute pair at the storage CHECK", () => {
    let caught: unknown;
    try {
      repo.createGroupSchedule(db, {
        userGroupId: groupId,
        targetKind: "overall",
        action: "allow",
        recurrenceStartMinute: 540,
      });
    } catch (err) {
      caught = err;
    }
    expect(repo.isCheckViolation(caught)).toBe(true);
  });

  it("creates a group exception ordered by expiry, with update + delete", () => {
    const later = repo.createGroupException(db, {
      userGroupId: groupId,
      targetKind: "overall",
      action: "allow",
      expiresAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    const sooner = repo.createGroupException(db, {
      userGroupId: groupId,
      targetKind: "overall",
      action: "allow",
      reason: "movie night",
      expiresAt: new Date("2026-07-01T12:00:00.000Z"),
    });
    expect(repo.listGroupExceptions(db, groupId).map((r) => r.id)).toEqual([sooner.id, later.id]);
    expect(repo.getGroupException(db, sooner.id)?.reason).toBe("movie night");

    const updated = repo.updateGroupException(db, later.id, { reason: "trip" });
    expect(updated?.reason).toBe("trip");
    expect(repo.deleteGroupException(db, later.id)).toBe(true);
    expect(repo.deleteGroupException(db, later.id)).toBe(false);
  });

  it("cascades group schedules and exceptions when the group is deleted", () => {
    repo.createGroupSchedule(db, { userGroupId: groupId, targetKind: "overall", action: "deny" });
    repo.createGroupException(db, {
      userGroupId: groupId,
      targetKind: "overall",
      action: "allow",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    repo.deleteUserGroup(db, groupId);
    expect(repo.listGroupSchedules(db, groupId)).toEqual([]);
    expect(repo.listGroupExceptions(db, groupId)).toEqual([]);
  });
});

describe("policy repository — group budgets (#134)", () => {
  let db: TestDb;
  let groupId: number;
  beforeEach(() => {
    db = testDb();
    groupId = repo.createUserGroup(db, { name: "Kids" }).id;
  });
  afterEach(() => {
    db.$client.close();
  });

  it("creates, lists, gets, updates and deletes a group budget", () => {
    const overall = repo.createGroupBudget(db, {
      userGroupId: groupId,
      scope: "overall",
      window: "daily",
      secondsAllowed: 7200,
    });
    expect(overall.targetId).toBeNull();
    expect(overall.secondsAllowed).toBe(7200);

    const weekly = repo.createGroupBudget(db, {
      userGroupId: groupId,
      scope: "overall",
      window: "weekly",
      secondsAllowed: 36000,
    });
    expect(repo.listGroupBudgets(db, groupId).map((r) => r.id)).toEqual([overall.id, weekly.id]);
    expect(repo.getGroupBudget(db, overall.id)?.window).toBe("daily");

    const updated = repo.updateGroupBudget(db, overall.id, { secondsAllowed: 5400 });
    expect(updated?.secondsAllowed).toBe(5400);
    expect(repo.deleteGroupBudget(db, overall.id)).toBe(true);
    expect(repo.deleteGroupBudget(db, overall.id)).toBe(false);
    expect(repo.getGroupBudget(db, overall.id)).toBeUndefined();
  });

  it("rejects a negative allowance at the storage CHECK", () => {
    let caught: unknown;
    try {
      repo.createGroupBudget(db, {
        userGroupId: groupId,
        scope: "overall",
        window: "daily",
        secondsAllowed: -1,
      });
    } catch (err) {
      caught = err;
    }
    expect(repo.isCheckViolation(caught)).toBe(true);
  });

  it("rejects an overall budget carrying a target_id (coherence CHECK)", () => {
    let caught: unknown;
    try {
      repo.createGroupBudget(db, {
        userGroupId: groupId,
        scope: "overall",
        targetId: 1,
        window: "daily",
        secondsAllowed: 60,
      });
    } catch (err) {
      caught = err;
    }
    expect(repo.isCheckViolation(caught)).toBe(true);
  });

  it("cascades group budgets when the group is deleted", () => {
    repo.createGroupBudget(db, {
      userGroupId: groupId,
      scope: "overall",
      window: "daily",
      secondsAllowed: 3600,
    });
    repo.deleteUserGroup(db, groupId);
    expect(repo.listGroupBudgets(db, groupId)).toEqual([]);
  });
});
