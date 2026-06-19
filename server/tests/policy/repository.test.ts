/**
 * Unit tests for the account/device-core repository (#51) against a hermetic
 * in-memory policy DB (`testDb`, foreign_keys ON). Covers CRUD round-trips,
 * ON DELETE CASCADE, link upsert, and the unique-violation signal the route
 * layer maps to 409.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as repo from "../../src/policy/repository.js";
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
    const link = repo.upsertLink(db, userId, clientId, { linuxUsername: "alice", linuxUid: 1001 });
    expect(link).toEqual({ userId, clientId, linuxUsername: "alice", linuxUid: 1001 });
    expect(repo.listUserLinks(db, userId)).toEqual([link]);

    // Re-upsert replaces the link's attributes rather than inserting a second.
    const replaced = repo.upsertLink(db, userId, clientId, {
      linuxUsername: "alice2",
      linuxUid: 1002,
    });
    expect(replaced.linuxUid).toBe(1002);
    expect(repo.listUserLinks(db, userId)).toEqual([replaced]);
  });

  it("rejects a duplicate (client, uid) for a different user with a unique violation", () => {
    const otherUser = repo.createUser(db, { displayName: "Bob" }).id;
    repo.upsertLink(db, userId, clientId, { linuxUsername: "alice", linuxUid: 1001 });
    let caught: unknown;
    try {
      repo.upsertLink(db, otherUser, clientId, { linuxUsername: "bob", linuxUid: 1001 });
    } catch (err) {
      caught = err;
    }
    expect(repo.isUniqueViolation(caught)).toBe(true);
  });

  it("cascades link removal when the user is deleted", () => {
    repo.upsertLink(db, userId, clientId, { linuxUsername: "alice", linuxUid: 1001 });
    expect(repo.deleteUser(db, userId)).toBe(true);
    expect(repo.listUserLinks(db, userId)).toEqual([]);
  });

  it("cascades link removal when the client is deleted", () => {
    repo.upsertLink(db, userId, clientId, { linuxUsername: "alice", linuxUid: 1001 });
    expect(repo.deleteClient(db, clientId)).toBe(true);
    expect(repo.listUserLinks(db, userId)).toEqual([]);
  });

  it("deleteLink reports whether a row was removed", () => {
    repo.upsertLink(db, userId, clientId, { linuxUsername: "alice", linuxUid: 1001 });
    expect(repo.deleteLink(db, userId, clientId)).toBe(true);
    expect(repo.deleteLink(db, userId, clientId)).toBe(false);
  });

  it("listUserClientIds returns the linked client ids ascending, [] when none", () => {
    expect(repo.listUserClientIds(db, userId)).toEqual([]);
    const second = repo.createClient(db, { hostname: "mint-02", sshUser: "pct-agent" }).id;
    repo.upsertLink(db, userId, second, { linuxUsername: "alice", linuxUid: 1002 });
    repo.upsertLink(db, userId, clientId, { linuxUsername: "alice", linuxUid: 1001 });
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

    expect(repo.getActivity(db, created.id)).toEqual(created);
    expect(repo.listActivities(db)).toEqual([created]);

    const updated = repo.updateActivity(db, created.id, { matcher: "firefox-esr" });
    expect(updated?.matcher).toBe("firefox-esr");
    expect(updated?.kind).toBe("app");

    expect(repo.deleteActivity(db, created.id)).toBe(true);
    expect(repo.getActivity(db, created.id)).toBeUndefined();
    expect(repo.deleteActivity(db, created.id)).toBe(false);
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
