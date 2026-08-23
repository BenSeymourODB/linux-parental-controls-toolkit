/**
 * Unit tests for the dry-run counting counterpart of the purge routines (#137).
 *
 * `countExpiredRecords` must agree with `purgeExpiredRecords` by construction:
 * the same per-category cutoff, the same strict `<` predicate, the same
 * four-table sum for `date_overrides`, and the same `keepForever ⇒ nothing`
 * escape hatch — but with no writes. These tests lock that agreement and the
 * side-effect-free guarantee.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  countAuditLog,
  countDateOverrides,
  countExpiredRecords,
  countGrants,
  countUsageSamples,
  purgeExpiredRecords,
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

function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}
function ahead(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}
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

function insertSample(start: Date, end: Date): void {
  db.insert(usageSamples)
    .values({ userId, clientId, activityId, startedAt: start, endedAt: end })
    .run();
}
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
function insertGrant(expiresAt: Date): void {
  db.insert(grants)
    .values({ userId, scope: "overall", secondsGranted: 1800, source: "admin", expiresAt })
    .run();
}

describe("countUsageSamples", () => {
  it("counts samples whose interval ended before the cutoff without deleting", () => {
    insertSample(ago(101), ago(100)); // wholly past
    insertSample(ago(10), ago(9)); // recent
    const result = countUsageSamples(db, windowDays(30), NOW);
    expect(result).toEqual({ category: "usage_samples", cutoff: ago(30), wouldDelete: 1 });
    // side-effect-free: both rows survive the count.
    expect(db.select().from(usageSamples).all()).toHaveLength(2);
  });

  it("reports zero and a null cutoff when kept forever", () => {
    insertSample(ago(1000), ago(999));
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "usage_samples", keepForever: true, days: null },
    ]);
    expect(countUsageSamples(db, policy, NOW)).toEqual({
      category: "usage_samples",
      cutoff: null,
      wouldDelete: 0,
    });
  });

  it("excludes a sample that ended exactly on the cutoff (strict <)", () => {
    insertSample(ago(31), ago(30));
    expect(countUsageSamples(db, windowDays(30), NOW).wouldDelete).toBe(0);
  });
});

describe("countGrants / countAuditLog", () => {
  it("counts expired grants and old audit rows", () => {
    insertGrant(ago(100));
    insertGrant(ahead(1));
    insertAudit(ago(100));
    insertAudit(ago(5));
    expect(countGrants(db, windowDays(30), NOW).wouldDelete).toBe(1);
    expect(countAuditLog(db, windowDays(30), NOW).wouldDelete).toBe(1);
  });
});

describe("countDateOverrides", () => {
  it("sums across all four override tables under one cutoff", () => {
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
    // Open-ended recurrence rule (null effective_to) must never be counted.
    db.insert(schedules).values({ userId, targetKind: "overall", action: "deny" }).run();
    expect(countDateOverrides(db, windowDays(30), NOW)).toEqual({
      category: "date_overrides",
      cutoff: ago(30),
      wouldDelete: 4,
    });
  });
});

describe("countExpiredRecords", () => {
  it("returns one result per category in declaration order", () => {
    expect(countExpiredRecords(db, windowDays(30), NOW).map((r) => r.category)).toEqual([
      "usage_samples",
      "grant_ledger",
      "audit_log",
      "date_overrides",
    ]);
  });

  it("agrees with purgeExpiredRecords row-for-row, then the purge deletes exactly that many", () => {
    insertSample(ago(100), ago(99));
    insertGrant(ago(100));
    insertAudit(ago(100));
    db.insert(exceptions)
      .values({ userId, targetKind: "overall", action: "allow", expiresAt: ago(100) })
      .run();

    const preview = countExpiredRecords(db, windowDays(30), NOW);
    // Nothing deleted yet — the preview is a read.
    expect(db.select().from(usageSamples).all()).toHaveLength(1);

    const purged = purgeExpiredRecords(db, windowDays(30), NOW);
    for (const p of purged) {
      const c = preview.find((r) => r.category === p.category);
      expect(c?.wouldDelete).toBe(p.deleted);
      expect(c?.cutoff).toEqual(p.cutoff);
    }
    // Every category had exactly one expired row.
    expect(preview.reduce((s, r) => s + r.wouldDelete, 0)).toBe(4);
  });
});
