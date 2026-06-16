/**
 * Shared test database helper.
 *
 * `testDb()` returns a fresh, in-memory better-sqlite3 database wrapped by
 * Drizzle with the committed migrations applied. Policy-layer unit tests use
 * it for hermetic, fast (no file I/O, no leftover state) coverage — see
 * `docs/testing.md` → "Mock patterns by layer → Policy model".
 *
 * Phase 1 ships an empty migration journal (no tables yet), so the migrator
 * only provisions its bookkeeping table. The helper keeps working unchanged
 * once Phase 2 adds real tables on top of the scaffold (#9).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// Resolve the committed migrations folder relative to this file rather than
// the process cwd, so the helper works regardless of where the runner is
// invoked from — same approach as tests/policy/migrations.test.ts.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * A migrated in-memory Drizzle database. The underlying better-sqlite3 handle
 * is reachable via `.$client` (e.g. `db.$client.close()` to free it).
 */
export type TestDb = BetterSQLite3Database<Record<string, never>> & {
  $client: Database.Database;
};

/**
 * Build a fresh in-memory policy database with all migrations applied.
 *
 * Each call is an independent `:memory:` database, so tests never share
 * state. Close the underlying handle with `db.$client.close()` when done (or
 * let it be reclaimed at process exit for short-lived unit tests).
 */
export function testDb(): TestDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder });
  return db;
}
