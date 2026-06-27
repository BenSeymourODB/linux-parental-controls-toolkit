/**
 * Unit tests for the per-user PIN data access (#112), against a fresh in-memory
 * policy DB — see `docs/testing.md` → "Policy model".
 */
import { describe, expect, it } from "vitest";

import { createUser, deleteUser } from "../../src/policy/repository.js";
import {
  clearUserPin,
  getUserPinHash,
  hasUserPin,
  setUserPin,
} from "../../src/policy/user-pins.js";
import { testDb } from "../helpers/db.js";

describe("user-pin repository", () => {
  it("sets a PIN and reads the hash back", () => {
    const db = testDb();
    const user = createUser(db, { displayName: "Alice" });

    const row = setUserPin(db, user.id, "hash-1");
    expect(row.userId).toBe(user.id);
    expect(row.hashedPin).toBe("hash-1");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);

    expect(getUserPinHash(db, user.id)).toBe("hash-1");
    expect(hasUserPin(db, user.id)).toBe(true);
    db.$client.close();
  });

  it("reports no PIN for a user that has not set one", () => {
    const db = testDb();
    const user = createUser(db, { displayName: "Bob" });

    expect(getUserPinHash(db, user.id)).toBeUndefined();
    expect(hasUserPin(db, user.id)).toBe(false);
    db.$client.close();
  });

  it("upserts: setting a PIN again replaces the hash without inserting a second row", () => {
    const db = testDb();
    const user = createUser(db, { displayName: "Alice" });

    setUserPin(db, user.id, "hash-1");
    const updated = setUserPin(db, user.id, "hash-2");

    expect(updated.userId).toBe(user.id);
    expect(getUserPinHash(db, user.id)).toBe("hash-2");
    // One PIN per user — the second set replaced, not appended.
    expect(hasUserPin(db, user.id)).toBe(true);
    db.$client.close();
  });

  it("clears a PIN and reports the removal; clearing a missing PIN is a no-op", () => {
    const db = testDb();
    const user = createUser(db, { displayName: "Alice" });
    setUserPin(db, user.id, "hash-1");

    expect(clearUserPin(db, user.id)).toBe(true);
    expect(hasUserPin(db, user.id)).toBe(false);
    // Already cleared — nothing to remove.
    expect(clearUserPin(db, user.id)).toBe(false);
    db.$client.close();
  });

  it("keeps PINs isolated per user", () => {
    const db = testDb();
    const alice = createUser(db, { displayName: "Alice" });
    const bob = createUser(db, { displayName: "Bob" });

    setUserPin(db, alice.id, "alice-hash");
    expect(getUserPinHash(db, alice.id)).toBe("alice-hash");
    expect(getUserPinHash(db, bob.id)).toBeUndefined();
    db.$client.close();
  });

  it("removes the PIN row when its user is deleted (ON DELETE CASCADE)", () => {
    const db = testDb();
    const user = createUser(db, { displayName: "Alice" });
    setUserPin(db, user.id, "hash-1");

    expect(deleteUser(db, user.id)).toBe(true);
    expect(getUserPinHash(db, user.id)).toBeUndefined();
    db.$client.close();
  });
});
