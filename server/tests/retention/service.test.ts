/**
 * Unit tests for the retention purge service (#137).
 *
 * `runRetentionPurge` must delete expired records, sum the per-category
 * deletions, and append exactly one ledger row (cutoffs stored as epoch
 * seconds); `previewRetentionPurge` must count the same rows without deleting
 * or recording anything. Hermetic in-memory DB seeded with the minimal parent
 * rows the category FKs require.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listPurgeRuns } from "../../src/policy/repository.js";
import { RetentionPolicy } from "../../src/policy/retention.js";
import {
  activities,
  auditLog,
  clients,
  exceptions,
  grants,
  usageSamples,
  users,
} from "../../src/policy/schema.js";
import { previewRetentionPurge, runRetentionPurge } from "../../src/retention/index.js";
import { testDb, type TestDb } from "../helpers/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-20T00:00:00.000Z");

function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}
function epochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
function windowDays(days: number): RetentionPolicy {
  return RetentionPolicy.fromOverrides(days, []);
}

let db: TestDb;
let userId: number;
let clientId: number;
let activityId: number;

beforeEach(() => {
  db = testDb();
  userId = db.insert(users).values({ displayName: "Alice" }).returning().get().id;
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

function seedOneExpiredPerCategory(): void {
  db.insert(usageSamples)
    .values({ userId, clientId, activityId, startedAt: ago(101), endedAt: ago(100) })
    .run();
  db.insert(grants)
    .values({ userId, scope: "overall", secondsGranted: 60, source: "admin", expiresAt: ago(100) })
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
}

describe("runRetentionPurge", () => {
  it("purges expired rows and records one ledger run with epoch-second cutoffs", () => {
    seedOneExpiredPerCategory();

    const row = runRetentionPurge(db, windowDays(30), NOW, { trigger: "scheduled" });

    expect(row.trigger).toBe("scheduled");
    expect(row.totalDeleted).toBe(4);
    expect(row.at).toEqual(NOW);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    // Every category deleted its single expired row.
    expect(row.items).toEqual([
      { category: "usage_samples", cutoff: epochSeconds(ago(30)), deleted: 1 },
      { category: "grant_ledger", cutoff: epochSeconds(ago(30)), deleted: 1 },
      { category: "audit_log", cutoff: epochSeconds(ago(30)), deleted: 1 },
      { category: "date_overrides", cutoff: epochSeconds(ago(30)), deleted: 1 },
    ]);
    // The rows are actually gone.
    expect(db.select().from(usageSamples).all()).toHaveLength(0);
    expect(db.select().from(grants).all()).toHaveLength(0);
    // Exactly one run recorded.
    expect(listPurgeRuns(db, 10)).toHaveLength(1);
  });

  it("records a keep-forever category with a null cutoff and zero deleted", () => {
    db.insert(usageSamples)
      .values({ userId, clientId, activityId, startedAt: ago(1000), endedAt: ago(999) })
      .run();
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "usage_samples", keepForever: true, days: null },
    ]);

    const row = runRetentionPurge(db, policy, NOW, { trigger: "manual" });

    expect(row.trigger).toBe("manual");
    expect(row.totalDeleted).toBe(0);
    const usage = row.items.find((i) => i.category === "usage_samples");
    expect(usage).toEqual({ category: "usage_samples", cutoff: null, deleted: 0 });
    expect(db.select().from(usageSamples).all()).toHaveLength(1);
  });

  it("honours a custom batch size (still deletes everything, in one recorded run)", () => {
    for (let i = 0; i < 5; i++) {
      db.insert(usageSamples)
        .values({ userId, clientId, activityId, startedAt: ago(100 + i), endedAt: ago(99 + i) })
        .run();
    }
    const row = runRetentionPurge(db, windowDays(30), NOW, { trigger: "scheduled", batchSize: 2 });
    expect(row.totalDeleted).toBe(5);
    expect(db.select().from(usageSamples).all()).toHaveLength(0);
    expect(listPurgeRuns(db, 10)).toHaveLength(1);
  });
});

describe("previewRetentionPurge", () => {
  it("counts what would be purged without deleting or recording a run", () => {
    seedOneExpiredPerCategory();

    const preview = previewRetentionPurge(db, windowDays(30), NOW);

    expect(preview.at).toEqual(NOW);
    expect(preview.totalWouldDelete).toBe(4);
    expect(preview.items.map((i) => [i.category, i.wouldDelete])).toEqual([
      ["usage_samples", 1],
      ["grant_ledger", 1],
      ["audit_log", 1],
      ["date_overrides", 1],
    ]);
    expect(preview.items[0]?.cutoff).toEqual(ago(30));
    // No deletions, no ledger row.
    expect(db.select().from(usageSamples).all()).toHaveLength(1);
    expect(listPurgeRuns(db, 10)).toHaveLength(0);
  });

  it("reports a null cutoff for a kept-forever category", () => {
    const policy = RetentionPolicy.fromOverrides(30, [
      { category: "audit_log", keepForever: true, days: null },
    ]);
    const preview = previewRetentionPurge(db, policy, NOW);
    const audit = preview.items.find((i) => i.category === "audit_log");
    expect(audit).toEqual({ category: "audit_log", cutoff: null, wouldDelete: 0 });
  });
});
