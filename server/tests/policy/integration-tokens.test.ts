/**
 * Unit tests for the integration-token data access (#114), against a fresh
 * in-memory policy DB — see `docs/testing.md` → "Policy model".
 */
import { describe, expect, it } from "vitest";

import { isUniqueViolation } from "../../src/policy/repository.js";
import {
  createIntegrationToken,
  findIntegrationTokenByHash,
  getIntegrationToken,
  listIntegrationTokens,
  revokeIntegrationToken,
  touchIntegrationTokenLastUsed,
} from "../../src/policy/integration-tokens.js";
import { testDb } from "../helpers/db.js";

describe("integration-token repository", () => {
  it("creates a token and reads it back by id, hash, and list", () => {
    const db = testDb();
    const row = createIntegrationToken(db, {
      name: "calendar",
      scopes: ["grants:write"],
      hashedSecret: "deadbeef",
    });

    expect(row.id).toBeGreaterThan(0);
    expect(row.name).toBe("calendar");
    expect(row.scopes).toEqual(["grants:write"]);
    expect(row.revokedAt).toBeNull();
    expect(row.lastUsedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);

    expect(getIntegrationToken(db, row.id)?.name).toBe("calendar");
    expect(findIntegrationTokenByHash(db, "deadbeef")?.id).toBe(row.id);
    expect(listIntegrationTokens(db)).toHaveLength(1);
    db.$client.close();
  });

  it("returns undefined for an unknown id or hash", () => {
    const db = testDb();
    expect(getIntegrationToken(db, 999)).toBeUndefined();
    expect(findIntegrationTokenByHash(db, "nope")).toBeUndefined();
    db.$client.close();
  });

  it("orders the list oldest-first", () => {
    const db = testDb();
    createIntegrationToken(db, { name: "a", scopes: ["policy:read"], hashedSecret: "h1" });
    createIntegrationToken(db, { name: "b", scopes: ["policy:read"], hashedSecret: "h2" });
    expect(listIntegrationTokens(db).map((r) => r.name)).toEqual(["a", "b"]);
    db.$client.close();
  });

  it("rejects a duplicate name with a unique violation", () => {
    const db = testDb();
    createIntegrationToken(db, { name: "calendar", scopes: ["grants:write"], hashedSecret: "h1" });
    try {
      createIntegrationToken(db, { name: "calendar", scopes: ["policy:read"], hashedSecret: "h2" });
      expect.unreachable("expected a unique violation");
    } catch (err) {
      expect(isUniqueViolation(err)).toBe(true);
    }
    db.$client.close();
  });

  it("revokes idempotently, preserving the original revoked_at", async () => {
    const db = testDb();
    const row = createIntegrationToken(db, {
      name: "calendar",
      scopes: ["grants:write"],
      hashedSecret: "h1",
    });

    const first = revokeIntegrationToken(db, row.id);
    expect(first?.revokedAt).toBeInstanceOf(Date);
    const firstRevokedAt = first?.revokedAt?.getTime();

    // A second revoke must not move the timestamp.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = revokeIntegrationToken(db, row.id);
    expect(second?.revokedAt?.getTime()).toBe(firstRevokedAt);
    db.$client.close();
  });

  it("returns undefined when revoking an unknown id", () => {
    const db = testDb();
    expect(revokeIntegrationToken(db, 12345)).toBeUndefined();
    db.$client.close();
  });

  it("touches last_used_at", () => {
    const db = testDb();
    const row = createIntegrationToken(db, {
      name: "calendar",
      scopes: ["grants:write"],
      hashedSecret: "h1",
    });
    expect(getIntegrationToken(db, row.id)?.lastUsedAt).toBeNull();
    touchIntegrationTokenLastUsed(db, row.id);
    expect(getIntegrationToken(db, row.id)?.lastUsedAt).toBeInstanceOf(Date);
    db.$client.close();
  });
});
