/**
 * Unit tests for the retention purge-run ledger repository (#137):
 * `recordPurgeRun` and `listPurgeRuns`. The `items` JSON column must
 * round-trip, and reads must be newest-first (ties broken by id).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listPurgeRuns,
  recordPurgeRun,
  type RecordPurgeRunInput,
} from "../../src/policy/repository.js";
import type { RetentionPurgeRunItem } from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

let db: TestDb;

beforeEach(() => {
  db = testDb();
});
afterEach(() => {
  db.$client.close();
});

const ITEMS: RetentionPurgeRunItem[] = [
  { category: "usage_samples", cutoff: 1_700_000_000, deleted: 3 },
  { category: "grant_ledger", cutoff: null, deleted: 0 },
  { category: "audit_log", cutoff: 1_700_000_000, deleted: 1 },
  { category: "date_overrides", cutoff: 1_700_000_000, deleted: 2 },
];

function run(at: Date, overrides: Partial<RecordPurgeRunInput> = {}): void {
  recordPurgeRun(db, {
    at,
    trigger: "scheduled",
    totalDeleted: 6,
    durationMs: 42,
    items: ITEMS,
    ...overrides,
  });
}

describe("recordPurgeRun", () => {
  it("persists a run and round-trips the items JSON", () => {
    const row = recordPurgeRun(db, {
      at: new Date("2026-06-20T03:00:00.000Z"),
      trigger: "manual",
      totalDeleted: 6,
      durationMs: 42,
      items: ITEMS,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.trigger).toBe("manual");
    expect(row.totalDeleted).toBe(6);
    expect(row.durationMs).toBe(42);
    expect(row.at).toEqual(new Date("2026-06-20T03:00:00.000Z"));
    expect(row.items).toEqual(ITEMS);
  });
});

describe("listPurgeRuns", () => {
  it("returns empty when no run has ever executed", () => {
    expect(listPurgeRuns(db, 10)).toEqual([]);
  });

  it("orders newest-first by at, then by id for same-instant ties", () => {
    run(new Date("2026-06-18T03:00:00.000Z"));
    // Two runs at the same instant: the later insert (higher id) must sort first.
    run(new Date("2026-06-20T03:00:00.000Z"), { trigger: "manual" });
    run(new Date("2026-06-20T03:00:00.000Z"), { trigger: "scheduled" });

    const rows = listPurgeRuns(db, 10);
    expect(rows).toHaveLength(3);
    // Newest instant first; within it, the higher id (last inserted) leads.
    expect(rows[0]?.at).toEqual(new Date("2026-06-20T03:00:00.000Z"));
    expect(rows[1]?.at).toEqual(new Date("2026-06-20T03:00:00.000Z"));
    expect(rows[0]?.id).toBeGreaterThan(rows[1]?.id ?? 0);
    expect(rows[2]?.at).toEqual(new Date("2026-06-18T03:00:00.000Z"));

    // The "last-run summary" is simply the first element.
    expect(listPurgeRuns(db, 1)).toEqual([rows[0]]);
  });

  it("caps the result at the requested limit", () => {
    for (let i = 0; i < 5; i++) {
      run(new Date(`2026-06-2${i}T03:00:00.000Z`));
    }
    expect(listPurgeRuns(db, 2)).toHaveLength(2);
  });
});
