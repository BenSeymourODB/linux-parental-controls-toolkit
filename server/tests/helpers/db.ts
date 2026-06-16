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
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { PolicyDb } from "../../src/policy/db.js";
import * as schema from "../../src/policy/schema.js";

// Resolve the committed migrations folder relative to this file rather than
// the process cwd, so the helper works regardless of where the runner is
// invoked from — same approach as tests/policy/migrations.test.ts.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * A migrated in-memory Drizzle database. Typed identically to the runtime
 * {@link PolicyDb} (same schema) so it can be injected into `buildApp` via
 * `buildTestApp`; the underlying better-sqlite3 handle is reachable via
 * `.$client` (e.g. `db.$client.close()` to free it).
 */
export type TestDb = PolicyDb;

/**
 * Build a fresh in-memory policy database with all migrations applied.
 *
 * Each call is an independent `:memory:` database, so tests never share
 * state. Close the underlying handle with `db.$client.close()` when done (or
 * let it be reclaimed at process exit for short-lived unit tests).
 */
export function testDb(): TestDb {
  const sqlite = new Database(":memory:");
  // Schema-typed (like createDb) so app.db and the injected test handle share
  // one type; in-memory ignores WAL, and foreign_keys is left at SQLite's
  // default here since hermetic unit tests opt into FK checks when they need
  // them. Once CRUD routes land (#51), consider enabling foreign_keys here so
  // route tests over app.db catch referential bugs the way runtime does.
  const db: PolicyDb = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
