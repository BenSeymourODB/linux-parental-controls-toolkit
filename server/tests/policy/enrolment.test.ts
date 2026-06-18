/**
 * Unit tests for the enrolment data access (#77) against a hermetic in-memory
 * policy DB. Covers token insert/lookup, the consume+enrol transaction, and its
 * atomicity (a duplicate Linux UID rolls the whole thing back — no half-created
 * client, no consumed token).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as enrolmentRepo from "../../src/policy/enrolment.js";
import * as repo from "../../src/policy/repository.js";
import { clients } from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("enrolment repository", () => {
  let db: TestDb;
  beforeEach(() => {
    db = testDb();
  });
  afterEach(() => {
    db.$client.close();
  });

  function seedUser(name = "Alice"): number {
    return repo.createUser(db, { displayName: name }).id;
  }

  it("creates and looks up an enrolment token by hash", () => {
    const userId = seedUser();
    const created = enrolmentRepo.createEnrolmentToken(db, {
      tokenHash: "deadbeef",
      hostname: "mint-01",
      supervisedUsers: [{ userId, linuxUsername: "alice" }],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.consumedAt).toBeNull();
    expect(created.supervisedUsers).toEqual([{ userId, linuxUsername: "alice" }]);

    const found = enrolmentRepo.findEnrolmentTokenByHash(db, "deadbeef");
    expect(found?.id).toBe(created.id);
    expect(enrolmentRepo.findEnrolmentTokenByHash(db, "nope")).toBeUndefined();
  });

  it("consumes a token and enrols the client + links atomically", () => {
    const userId = seedUser();
    const token = enrolmentRepo.createEnrolmentToken(db, {
      tokenHash: "hash-1",
      supervisedUsers: [{ userId, linuxUsername: "alice" }],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });

    const result = enrolmentRepo.consumeTokenAndEnrol(db, token.id, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      bearerTokenHash: "bearer-hash",
      links: [{ userId, linuxUsername: "alice", linuxUid: 1000 }],
    });

    expect(result.client.hostname).toBe("mint-01");
    expect(result.client.bearerTokenHash).toBe("bearer-hash");
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ userId, linuxUid: 1000 });

    const reloaded = enrolmentRepo.findEnrolmentTokenByHash(db, "hash-1");
    expect(reloaded?.consumedAt).toBeInstanceOf(Date);
    expect(reloaded?.consumedClientId).toBe(result.client.id);
  });

  it("refuses to consume an already-consumed token and rolls back (single-use guard)", () => {
    const userId = seedUser();
    const token = enrolmentRepo.createEnrolmentToken(db, {
      tokenHash: "hash-guard",
      supervisedUsers: [{ userId, linuxUsername: "alice" }],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    const links = [{ userId, linuxUsername: "alice", linuxUid: 1000 }];
    enrolmentRepo.consumeTokenAndEnrol(db, token.id, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      bearerTokenHash: "bearer-hash-1",
      links,
    });

    // A second redeem of the same token must throw (the consume guard) and
    // create no second client. A fresh bearer hash is used so the rollback is
    // driven by the consumed-token guard, not the bearer-hash unique index.
    expect(() =>
      enrolmentRepo.consumeTokenAndEnrol(db, token.id, {
        hostname: "mint-02",
        sshUser: "pct-agent",
        bearerTokenHash: "bearer-hash-2",
        links,
      }),
    ).toThrow(enrolmentRepo.EnrolmentTokenConsumedError);
    expect(db.select().from(clients).all()).toHaveLength(1);
  });

  it("rolls back the whole enrolment if a link violates a constraint", () => {
    const userId = seedUser();
    const token = enrolmentRepo.createEnrolmentToken(db, {
      tokenHash: "hash-2",
      supervisedUsers: [{ userId, linuxUsername: "alice" }],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });

    // Two links sharing one UID trips the (client, linux_uid) unique index
    // mid-transaction; the client insert + token-consume must roll back with it.
    expect(() =>
      enrolmentRepo.consumeTokenAndEnrol(db, token.id, {
        hostname: "mint-01",
        sshUser: "pct-agent",
        bearerTokenHash: "bearer-hash",
        links: [
          { userId, linuxUsername: "alice", linuxUid: 1000 },
          { userId, linuxUsername: "alice2", linuxUid: 1000 },
        ],
      }),
    ).toThrow();

    expect(db.select().from(clients).all()).toHaveLength(0);
    const reloaded = enrolmentRepo.findEnrolmentTokenByHash(db, "hash-2");
    expect(reloaded?.consumedAt).toBeNull();
    expect(reloaded?.consumedClientId).toBeNull();
  });
});
