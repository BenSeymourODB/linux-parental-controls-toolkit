/**
 * Repository tests for the retention-override CRUD (#136), against a hermetic
 * in-memory policy DB with `foreign_keys`/CHECK enforcement on — so these
 * exercise the real `retention_overrides` storage invariants the route layer
 * relies on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteRetentionOverride,
  isCheckViolation,
  listRetentionOverrides,
  upsertRetentionOverride,
} from "../../src/policy/repository.js";
import { retentionOverrides } from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("retention-override repository", () => {
  let db: TestDb;

  beforeEach(() => {
    db = testDb();
  });

  afterEach(() => {
    db.$client.close();
  });

  it("starts with no overrides", () => {
    expect(listRetentionOverrides(db)).toEqual([]);
  });

  it("inserts a custom-window override and reads it back", () => {
    const row = upsertRetentionOverride(db, "usage_samples", { keepForever: false, days: 30 });
    expect(row.category).toBe("usage_samples");
    expect(row.keepForever).toBe(false);
    expect(row.days).toBe(30);
    expect(row.updatedAt).toBeInstanceOf(Date);

    expect(listRetentionOverrides(db)).toHaveLength(1);
  });

  it("inserts a keep-forever override with a null day count", () => {
    const row = upsertRetentionOverride(db, "audit_log", { keepForever: true });
    expect(row.keepForever).toBe(true);
    expect(row.days).toBeNull();
  });

  it("upserts in place (one row per category) and refreshes updated_at", () => {
    const first = upsertRetentionOverride(db, "grant_ledger", { keepForever: false, days: 90 });
    const second = upsertRetentionOverride(db, "grant_ledger", { keepForever: true });

    const all = listRetentionOverrides(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.keepForever).toBe(true);
    expect(all[0]?.days).toBeNull();
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("orders the list by category", () => {
    upsertRetentionOverride(db, "usage_samples", { keepForever: false, days: 30 });
    upsertRetentionOverride(db, "audit_log", { keepForever: true });
    upsertRetentionOverride(db, "grant_ledger", { keepForever: false, days: 90 });

    expect(listRetentionOverrides(db).map((r) => r.category)).toEqual([
      "audit_log",
      "grant_ledger",
      "usage_samples",
    ]);
  });

  it("deletes an override and reports whether one was removed", () => {
    upsertRetentionOverride(db, "date_overrides", { keepForever: false, days: 14 });
    expect(deleteRetentionOverride(db, "date_overrides")).toBe(true);
    expect(listRetentionOverrides(db)).toEqual([]);
    // A second delete removes nothing.
    expect(deleteRetentionOverride(db, "date_overrides")).toBe(false);
  });

  it("the storage CHECK rejects a custom window with a non-positive day count", () => {
    // The repo always passes coherent values, so go under it to prove the
    // CHECK actually guards the invariant the model assumes.
    let thrown: unknown;
    try {
      db.insert(retentionOverrides)
        .values({ category: "usage_samples", keepForever: false, days: 0 })
        .run();
    } catch (err) {
      thrown = err;
    }
    expect(isCheckViolation(thrown)).toBe(true);
  });

  it("the storage CHECK rejects keep-forever carrying a day count", () => {
    let thrown: unknown;
    try {
      db.insert(retentionOverrides)
        .values({ category: "audit_log", keepForever: true, days: 30 })
        .run();
    } catch (err) {
      thrown = err;
    }
    expect(isCheckViolation(thrown)).toBe(true);
  });
});
