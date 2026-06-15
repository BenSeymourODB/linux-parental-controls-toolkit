/**
 * Exercises the committed drizzle-kit migrations against a fresh in-memory
 * SQLite database — the runtime counterpart to the `drizzle-kit check` drift
 * gate that CI's `migrations` job runs (`.github/workflows/integration.yml`).
 *
 * Phase 1 ships an empty migration journal (no tables yet); these tests
 * pin the invariants the scaffold must keep as Phase 2 adds real tables:
 * applying all migrations to an empty DB succeeds, and re-applying is a
 * no-op. See `docs/testing.md` → "Policy module — what to test".
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

// Resolve the committed migrations folder relative to this file so the test
// is independent of the working directory the runner is invoked from.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Drizzle records applied migrations in this bookkeeping table. */
function migrationTableExists(sqlite: Database.Database): boolean {
  const row = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();
  return row !== undefined;
}

/** How many migrations the migrator believes it has applied. */
function appliedMigrationCount(sqlite: Database.Database): number {
  const value = sqlite.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get();
  if (typeof value !== "number") {
    throw new Error(`expected a numeric count, got ${typeof value}`);
  }
  return value;
}

describe("policy migrations", () => {
  it("applies all migrations to an empty database", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);

    expect(() => migrate(db, { migrationsFolder })).not.toThrow();
    // The migrator always provisions its bookkeeping table, even with an
    // empty journal — proof the folder was read and the pipeline ran.
    expect(migrationTableExists(sqlite)).toBe(true);

    sqlite.close();
  });

  it("is a no-op when re-applied to an already-migrated database", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);

    migrate(db, { migrationsFolder });
    const countAfterFirst = appliedMigrationCount(sqlite);

    expect(() => migrate(db, { migrationsFolder })).not.toThrow();
    // Re-applying must not record any additional migrations — the journal's
    // bookkeeping count is unchanged. (Phase-1 empty journal: stays 0; the
    // assertion keeps holding once Phase 2 adds real migrations.)
    expect(appliedMigrationCount(sqlite)).toBe(countAfterFirst);

    sqlite.close();
  });
});
