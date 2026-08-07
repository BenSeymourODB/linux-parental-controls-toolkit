/**
 * Unit tests for per-entity retention purge coverage (#138).
 *
 * Hermetic: a fresh in-memory policy DB (`testDb()`) with FKs on, seeded with
 * the minimal parent rows the category tables' FKs require. Each test locks one
 * of the invariants the epic (#135) calls for: a record past the window is
 * purged, an active / future-dated / referenced one is kept, open-ended
 * recurrence rules are never touched, the grant ledger's active-grant and
 * immutability guarantees hold, and the batched delete is bounded, exact, and
 * idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PURGE_BATCH_SIZE,
  purgeAuditLog,
  purgeDateOverrides,
  purgeExpiredRecords,
  purgeGrants,
  purgeUsageSamples,
} from "../../src/policy/purge.js";
import { RetentionPolicy } from "../../src/policy/retention.js";
import {
  activities,
  auditLog,
  clients,
  exceptions,
  grants,
  groupExceptions,
  groupSchedules,
  schedules,
  userGroups,
  usageSamples,
  users,
} from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-20T00:00:00.000Z");

/** A timestamp `days` before {@link NOW}. */
function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** A timestamp `days` after {@link NOW}. */
function ahead(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

/** A retention policy with a uniform finite window across every category. */
function windowDays(days: number): RetentionPolicy {
  return RetentionPolicy.fromOverrides(days, []);
}

let db: TestDb;
let userId: number;
let groupId: number;
let clientId: number;
let activityId: number;

beforeEach(() => {
  db = testDb();
  userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
  groupId = db.insert(userGroups).values({ name: "Kids" }).returning().get().id;
  clientId = db
    .insert(clients)
    .values({ hostname: "alice-pc", sshUser: "pct-agent" })
    .returning()
    .get().id;
  activityId = db
    .insert(activities)
    .values({ kind: "app", matcher: "firefox" })
    .returning()
    .get().id;
});

afterEach(() => {
  db.$client.close();
});

/** Insert a usage sample spanning `[start, end)`. */
function insertSample(start: Date, end: Date): void {
  db.insert(usageSamples)
    .values({ userId, clientId, activityId, startedAt: start, endedAt: end })
    .run();
}

function countUsageSamples(): number {
  return db.select().from(usageSamples).all().length;
}

describe("purgeUsageSamples", () => {
  it("purges samples whose interval ended before the cutoff, keeps the rest", () => {
    insertSample(ago(101), ago(100)); // wholly past 30-day window → purge
    insertSample(ago(10), ago(9)); // recent → keep
    const result = purgeUsageSamples(db, windowDays(30), NOW);
    expect(result).toEqual({ category: "usage_samples", cutoff: ago(30), deleted: 1 });
    expect(countUsageSamples()).toBe(1);
  });

  it("keeps a sample that started before but ended within the window", () => {
    // Straddles the cutoff (ended_at is after it) → the interval is not wholly past.
    insertSample(ago(40), ago(20));
    const result = purgeUsageSamples(db, windowDays(30), NOW);
    expect(result.deleted).toBe(0);
    expect(countUsageSamples()).toBe(1);
  });

  it("purges nothing when the category is kept forever", () => {
    insertSample(ago(1000), ago(999));
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "usage_samples", keepForever: true, days: null },
    ]);
    const result = purgeUsageSamples(db, policy, NOW);
    expect(result).toEqual({ category: "usage_samples", cutoff: null, deleted: 0 });
    expect(countUsageSamples()).toBe(1);
  });
});

describe("purgeDateOverrides", () => {
  it("purges exceptions past expires_at, keeps active and future ones", () => {
    db.insert(exceptions)
      .values({ userId, targetKind: "overall", action: "allow", expiresAt: ago(100) })
      .run();
    db.insert(exceptions)
      .values({ userId, targetKind: "overall", action: "allow", expiresAt: ahead(1) })
      .run();
    const result = purgeDateOverrides(db, windowDays(30), NOW);
    expect(result.deleted).toBe(1);
    expect(db.select().from(exceptions).all()).toHaveLength(1);
  });

  it("purges group exceptions past expires_at", () => {
    db.insert(groupExceptions)
      .values({ userGroupId: groupId, targetKind: "overall", action: "deny", expiresAt: ago(100) })
      .run();
    const result = purgeDateOverrides(db, windowDays(30), NOW);
    expect(result.deleted).toBe(1);
    expect(db.select().from(groupExceptions).all()).toHaveLength(0);
  });

  it("purges date-scoped schedules past effective_to but never open-ended recurrence rules", () => {
    // Date-scoped, wholly in the past → purge.
    db.insert(schedules)
      .values({ userId, targetKind: "overall", action: "deny", effectiveTo: ago(100) })
      .run();
    // Open-ended recurring rule (null effective_to) → always keep.
    db.insert(schedules).values({ userId, targetKind: "overall", action: "deny" }).run();
    // Date window still open (effective_to in the future) → keep.
    db.insert(schedules)
      .values({ userId, targetKind: "overall", action: "deny", effectiveTo: ahead(1) })
      .run();
    const result = purgeDateOverrides(db, windowDays(30), NOW);
    expect(result.deleted).toBe(1);
    expect(db.select().from(schedules).all()).toHaveLength(2);
  });

  it("purges date-scoped group schedules but never open-ended ones", () => {
    db.insert(groupSchedules)
      .values({
        userGroupId: groupId,
        targetKind: "overall",
        action: "deny",
        effectiveTo: ago(100),
      })
      .run();
    db.insert(groupSchedules)
      .values({ userGroupId: groupId, targetKind: "overall", action: "deny" })
      .run();
    const result = purgeDateOverrides(db, windowDays(30), NOW);
    expect(result.deleted).toBe(1);
    expect(db.select().from(groupSchedules).all()).toHaveLength(1);
  });

  it("sums deletions across all four tables under one cutoff", () => {
    db.insert(exceptions)
      .values({ userId, targetKind: "overall", action: "allow", expiresAt: ago(100) })
      .run();
    db.insert(groupExceptions)
      .values({ userGroupId: groupId, targetKind: "overall", action: "deny", expiresAt: ago(100) })
      .run();
    db.insert(schedules)
      .values({ userId, targetKind: "overall", action: "deny", effectiveTo: ago(100) })
      .run();
    db.insert(groupSchedules)
      .values({
        userGroupId: groupId,
        targetKind: "overall",
        action: "deny",
        effectiveTo: ago(100),
      })
      .run();
    const result = purgeDateOverrides(db, windowDays(30), NOW);
    expect(result).toEqual({ category: "date_overrides", cutoff: ago(30), deleted: 4 });
  });

  it("purges nothing when the category is kept forever", () => {
    db.insert(exceptions)
      .values({ userId, targetKind: "overall", action: "allow", expiresAt: ago(1000) })
      .run();
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "date_overrides", keepForever: true, days: null },
    ]);
    const result = purgeDateOverrides(db, policy, NOW);
    expect(result).toEqual({ category: "date_overrides", cutoff: null, deleted: 0 });
    expect(db.select().from(exceptions).all()).toHaveLength(1);
  });
});

describe("purgeAuditLog", () => {
  function insertAudit(at: Date): void {
    db.insert(auditLog)
      .values({
        at,
        targetHost: "alice-pc",
        targetPort: 22,
        targetUser: "pct-agent",
        command: ["timekpra", "--userinfo", "alice"],
        outcome: "ok",
        durationMs: 12,
      })
      .run();
  }

  it("purges entries older than the window, keeps recent ones", () => {
    insertAudit(ago(100));
    insertAudit(ago(5));
    const result = purgeAuditLog(db, windowDays(30), NOW);
    expect(result).toEqual({ category: "audit_log", cutoff: ago(30), deleted: 1 });
    expect(db.select().from(auditLog).all()).toHaveLength(1);
  });

  it("purges nothing when the category is kept forever", () => {
    insertAudit(ago(1000));
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "audit_log", keepForever: true, days: null },
    ]);
    const result = purgeAuditLog(db, policy, NOW);
    expect(result).toEqual({ category: "audit_log", cutoff: null, deleted: 0 });
    expect(db.select().from(auditLog).all()).toHaveLength(1);
  });
});

describe("purgeGrants", () => {
  function insertGrant(values: { expiresAt: Date; grantedAt?: Date; revokedAt?: Date }): void {
    db.insert(grants)
      .values({
        userId,
        scope: "overall",
        secondsGranted: 1800,
        source: "admin",
        ...values,
      })
      .run();
  }

  it("purges an expired grant, keeps one that has not yet expired", () => {
    insertGrant({ expiresAt: ago(100) });
    insertGrant({ expiresAt: ahead(1) });
    const result = purgeGrants(db, windowDays(30), NOW);
    expect(result).toEqual({ category: "grant_ledger", cutoff: ago(30), deleted: 1 });
    expect(db.select().from(grants).all()).toHaveLength(1);
  });

  it("keeps an active grant even when its ledger age exceeds the window", () => {
    // Granted long ago but still in effect (expires in the future): never purge.
    insertGrant({ grantedAt: ago(1000), expiresAt: ahead(1) });
    const result = purgeGrants(db, windowDays(30), NOW);
    expect(result.deleted).toBe(0);
    expect(db.select().from(grants).all()).toHaveLength(1);
  });

  it("purges a revoked-and-expired grant with its revocation on the same row", () => {
    insertGrant({ expiresAt: ago(100), revokedAt: ago(90) });
    const result = purgeGrants(db, windowDays(30), NOW);
    expect(result.deleted).toBe(1);
    expect(db.select().from(grants).all()).toHaveLength(0);
  });

  it("purges nothing when the ledger is kept forever", () => {
    insertGrant({ expiresAt: ago(1000) });
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "grant_ledger", keepForever: true, days: null },
    ]);
    const result = purgeGrants(db, policy, NOW);
    expect(result).toEqual({ category: "grant_ledger", cutoff: null, deleted: 0 });
    expect(db.select().from(grants).all()).toHaveLength(1);
  });
});

describe("batching", () => {
  it("deletes every expired row across multiple passes and is idempotent", () => {
    for (let i = 0; i < 5; i++) {
      insertSample(ago(100 + i), ago(99 + i));
    }
    insertSample(ago(2), ago(1)); // one recent survivor
    const first = purgeUsageSamples(db, windowDays(30), NOW, { batchSize: 2 });
    expect(first.deleted).toBe(5);
    expect(countUsageSamples()).toBe(1);
    // A second run finds nothing left — safe to resume / re-run.
    const second = purgeUsageSamples(db, windowDays(30), NOW, { batchSize: 2 });
    expect(second.deleted).toBe(0);
    expect(countUsageSamples()).toBe(1);
  });

  it("defaults the batch size when unset", () => {
    expect(DEFAULT_PURGE_BATCH_SIZE).toBeGreaterThan(0);
    insertSample(ago(100), ago(99));
    const result = purgeUsageSamples(db, windowDays(30), NOW);
    expect(result.deleted).toBe(1);
  });
});

describe("purgeExpiredRecords", () => {
  it("returns one result per category in declaration order", () => {
    const results = purgeExpiredRecords(db, windowDays(30), NOW);
    expect(results.map((r) => r.category)).toEqual([
      "usage_samples",
      "grant_ledger",
      "audit_log",
      "date_overrides",
    ]);
  });

  it("purges each category and reports its cutoff and count", () => {
    insertSample(ago(100), ago(99));
    db.insert(grants)
      .values({
        userId,
        scope: "overall",
        secondsGranted: 60,
        source: "admin",
        expiresAt: ago(100),
      })
      .run();
    db.insert(auditLog)
      .values({
        at: ago(100),
        targetHost: "h",
        targetPort: 22,
        targetUser: "pct-agent",
        command: ["x"],
        outcome: "ok",
        durationMs: 1,
      })
      .run();
    db.insert(exceptions)
      .values({ userId, targetKind: "overall", action: "allow", expiresAt: ago(100) })
      .run();

    const byCategory = new Map(
      purgeExpiredRecords(db, windowDays(30), NOW).map((r) => [r.category, r]),
    );
    expect(byCategory.get("usage_samples")).toEqual({
      category: "usage_samples",
      cutoff: ago(30),
      deleted: 1,
    });
    expect(byCategory.get("grant_ledger")?.deleted).toBe(1);
    expect(byCategory.get("audit_log")?.deleted).toBe(1);
    expect(byCategory.get("date_overrides")?.deleted).toBe(1);
  });

  it("leaves a keep-forever category untouched", () => {
    insertSample(ago(1000), ago(999));
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "usage_samples", keepForever: true, days: null },
    ]);
    const results = purgeExpiredRecords(db, policy, NOW);
    const usage = results.find((r) => r.category === "usage_samples");
    expect(usage).toEqual({ category: "usage_samples", cutoff: null, deleted: 0 });
    expect(countUsageSamples()).toBe(1);
  });
});
