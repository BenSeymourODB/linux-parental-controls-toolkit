/**
 * Unit tests for the grant-ledger data access (#113), against a fresh in-memory
 * policy DB — see `docs/testing.md` → "Policy model". Covers the create /
 * source_ref-lookup pair the grant endpoint uses, plus the structural
 * invariants the schema's CHECK / UNIQUE constraints backstop (ADR 0014).
 */
import { describe, expect, it } from "vitest";

import { createGrant, findGrantBySourceRef } from "../../src/policy/grants.js";
import {
  createActivity,
  createActivityGroup,
  createUser,
  isCheckViolation,
  isUniqueViolation,
} from "../../src/policy/repository.js";
import { testDb } from "../helpers/db.js";

/** A user id to hang grants off (grants.user_id is a FK with ON DELETE cascade). */
function seedUser(db: ReturnType<typeof testDb>): number {
  return createUser(db, { displayName: "Alice" }).id;
}

const FUTURE = new Date("2999-01-01T00:00:00.000Z");

describe("grant repository", () => {
  it("creates an overall grant and reads it back by source_ref", () => {
    const db = testDb();
    const userId = seedUser(db);

    const row = createGrant(db, {
      userId,
      scope: "overall",
      targetId: null,
      secondsGranted: 1800,
      expiresAt: FUTURE,
      source: "integration:calendar",
      sourceRef: "calendar:chore:1",
      reason: "Cleaned room",
    });

    expect(row.id).toBeGreaterThan(0);
    expect(row.userId).toBe(userId);
    expect(row.scope).toBe("overall");
    expect(row.targetId).toBeNull();
    expect(row.secondsGranted).toBe(1800);
    expect(row.source).toBe("integration:calendar");
    expect(row.sourceRef).toBe("calendar:chore:1");
    expect(row.reason).toBe("Cleaned room");
    expect(row.revokedAt).toBeNull();
    // granted_at is defaulted by the schema (timestampNow) to a real instant.
    expect(row.grantedAt).toBeInstanceOf(Date);

    const found = findGrantBySourceRef(db, "calendar:chore:1");
    expect(found?.id).toBe(row.id);
    expect(findGrantBySourceRef(db, "no-such-ref")).toBeUndefined();
  });

  it("supports activity- and group-scoped grants with a target", () => {
    const db = testDb();
    const userId = seedUser(db);
    const activityId = createActivity(db, { kind: "app", matcher: "firefox" }).id;
    const groupId = createActivityGroup(db, { name: "Games" }).id;

    const activityGrant = createGrant(db, {
      userId,
      scope: "activity",
      targetId: activityId,
      secondsGranted: 600,
      expiresAt: FUTURE,
      source: "integration:calendar",
      sourceRef: "calendar:activity:1",
      reason: null,
    });
    expect(activityGrant.scope).toBe("activity");
    expect(activityGrant.targetId).toBe(activityId);

    const groupGrant = createGrant(db, {
      userId,
      scope: "group",
      targetId: groupId,
      secondsGranted: 900,
      expiresAt: FUTURE,
      source: "integration:calendar",
      sourceRef: "calendar:group:1",
      reason: null,
    });
    expect(groupGrant.scope).toBe("group");
    expect(groupGrant.targetId).toBe(groupId);
  });

  it("rejects a duplicate source_ref with a unique violation", () => {
    const db = testDb();
    const userId = seedUser(db);
    const base = {
      userId,
      scope: "overall" as const,
      targetId: null,
      secondsGranted: 60,
      expiresAt: FUTURE,
      source: "integration:calendar",
      reason: null,
    };
    createGrant(db, { ...base, sourceRef: "dup" });

    let caught: unknown;
    try {
      createGrant(db, { ...base, sourceRef: "dup" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
    // The first row is still the one on record.
    expect(findGrantBySourceRef(db, "dup")).not.toBeUndefined();
  });

  it("allows distinct grants that both omit source_ref (NULLs are distinct)", () => {
    const db = testDb();
    const userId = seedUser(db);
    const base = {
      userId,
      scope: "overall" as const,
      targetId: null,
      secondsGranted: 60,
      expiresAt: FUTURE,
      source: "admin",
      sourceRef: null,
      reason: null,
    };
    expect(() => createGrant(db, base)).not.toThrow();
    expect(() => createGrant(db, base)).not.toThrow();
  });

  it("enforces the schema invariants as CHECK violations", () => {
    const db = testDb();
    const userId = seedUser(db);
    const valid = {
      userId,
      scope: "overall" as const,
      targetId: null,
      secondsGranted: 60,
      expiresAt: FUTURE,
      source: "integration:calendar",
      sourceRef: null,
      reason: null,
    };

    // seconds must be > 0
    let secondsErr: unknown;
    try {
      createGrant(db, { ...valid, secondsGranted: 0 });
    } catch (err) {
      secondsErr = err;
    }
    expect(isCheckViolation(secondsErr)).toBe(true);

    // overall must not carry a target
    let coherenceErr: unknown;
    try {
      createGrant(db, { ...valid, targetId: 5 });
    } catch (err) {
      coherenceErr = err;
    }
    expect(isCheckViolation(coherenceErr)).toBe(true);

    // source must be 'admin' or 'integration:%'
    let sourceErr: unknown;
    try {
      createGrant(db, { ...valid, source: "bogus" });
    } catch (err) {
      sourceErr = err;
    }
    expect(isCheckViolation(sourceErr)).toBe(true);
  });
});
