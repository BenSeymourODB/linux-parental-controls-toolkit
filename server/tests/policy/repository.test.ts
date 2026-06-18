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
