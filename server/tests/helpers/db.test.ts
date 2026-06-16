/**
 * Smoke test for the {@link testDb} helper: a fresh in-memory database has
 * the migrations applied and is independent per call.
 */
import { describe, expect, it } from "vitest";

import { testDb } from "./db.js";

describe("testDb helper", () => {
  it("applies the migrations to a fresh in-memory database", () => {
    const db = testDb();

    // The migrator always provisions its bookkeeping table once the journal
    // has been read — proof the migrations folder was found and applied.
    const row = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      )
      .get();
    expect(row).not.toBeUndefined();

    db.$client.close();
  });

  it("returns an independent database on each call", () => {
    const a = testDb();
    const b = testDb();

    expect(a.$client).not.toBe(b.$client);

    a.$client.close();
    b.$client.close();
  });
});
