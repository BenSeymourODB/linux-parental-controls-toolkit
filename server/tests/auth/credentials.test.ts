/**
 * Unit tests for the admin credential store and first-admin bootstrap (#52).
 */
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapAdmin, getAdmin } from "../../src/auth/credentials.js";
import { verifyPassword } from "../../src/auth/passwords.js";
import { testDb, type TestDb } from "../helpers/db.js";

/** A real (silent) FastifyBaseLogger so bootstrapAdmin gets a correctly-typed logger. */
function testLogger() {
  return Fastify({ logger: false }).log;
}

describe("admin credential bootstrap", () => {
  let db: TestDb;

  beforeEach(() => {
    db = testDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.$client.close();
  });

  it("getAdmin returns undefined on an empty store", () => {
    expect(getAdmin(db)).toBeUndefined();
  });

  it("seeds the admin from the environment, hashing the password", async () => {
    const result = await bootstrapAdmin(
      db,
      { adminUsername: "ben", adminPassword: "hunter2" },
      testLogger(),
    );
    expect(result).toBe("seeded");

    const admin = getAdmin(db);
    expect(admin?.username).toBe("ben");
    expect(admin?.id).toBe(1);
    // Stored as a hash, never the plaintext, and the hash verifies.
    expect(admin?.passwordHash).not.toContain("hunter2");
    expect(await verifyPassword(admin?.passwordHash ?? "", "hunter2")).toBe(true);
  });

  it("is idempotent: a second run with an existing admin is a no-op", async () => {
    await bootstrapAdmin(db, { adminUsername: "ben", adminPassword: "hunter2" }, testLogger());
    const firstHash = getAdmin(db)?.passwordHash;

    const result = await bootstrapAdmin(
      db,
      { adminUsername: "someone-else", adminPassword: "different" },
      testLogger(),
    );
    expect(result).toBe("already-exists");
    // The original admin is untouched — not overwritten or duplicated.
    const admin = getAdmin(db);
    expect(admin?.username).toBe("ben");
    expect(admin?.passwordHash).toBe(firstHash);
  });

  it("warns and seeds nothing when the bootstrap env is incomplete", async () => {
    const logger = testLogger();
    const warnSpy = vi.spyOn(logger, "warn");

    const onlyUser = await bootstrapAdmin(db, { adminUsername: "ben" }, logger);
    expect(onlyUser).toBe("unconfigured");

    const neither = await bootstrapAdmin(db, {}, logger);
    expect(neither).toBe("unconfigured");

    expect(getAdmin(db)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
