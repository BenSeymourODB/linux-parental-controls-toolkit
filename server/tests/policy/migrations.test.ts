/**
 * Exercises the committed drizzle-kit migrations against a fresh in-memory
 * SQLite database — the runtime counterpart to the `drizzle-kit check` drift
 * gate that CI's `migrations` job runs (`.github/workflows/integration.yml`).
 *
 * Phase 2 (#48) lands the first real migration; these tests pin the
 * invariants the pipeline must keep: applying all migrations to an empty DB
 * succeeds, the full policy schema is materialised, and re-applying is a
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

/** Names of every user-defined table in the database (excludes SQLite/Drizzle bookkeeping). */
function userTableNames(sqlite: Database.Database): string[] {
  return sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

/** Column names of a materialised table, in declaration order. */
function columnNames(sqlite: Database.Database, table: string): string[] {
  return sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all() as string[];
}

/**
 * Every table the committed migrations must materialise. These are the
 * policy-model tables (docs/architecture.md) plus `admin_credentials`, the
 * single-admin login row added in #52, and `transport_queue`, the offline-push
 * queue added in #84 (neither is part of the policy model — see their table
 * comments in `schema.ts`). Sorted to match the `ORDER BY name` query.
 */
const EXPECTED_TABLES = [
  "activities",
  "activities_to_groups",
  "activity_groups",
  "admin_credentials",
  "audit_log",
  "budgets",
  "clients",
  "enrolment_tokens",
  "exceptions",
  "grants",
  "integration_tokens",
  "notification_policies",
  "schedules",
  "transport_queue",
  "usage_samples",
  "user_group_memberships",
  "user_groups",
  "users",
  "users_on_clients",
];

describe("policy migrations", () => {
  it("applies all migrations to an empty database", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);

    expect(() => migrate(db, { migrationsFolder })).not.toThrow();
    // The migrator always provisions its bookkeeping table — proof the
    // folder was read and the pipeline ran.
    expect(migrationTableExists(sqlite)).toBe(true);

    sqlite.close();
  });

  it("materialises the full policy schema", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);

    migrate(db, { migrationsFolder });

    // Every policy-model table must exist, and no stray tables beyond them.
    expect(userTableNames(sqlite)).toStrictEqual(EXPECTED_TABLES);

    sqlite.close();
  });

  it("reserves the recurrence + date-scoping columns and drops cron_or_window (#146)", () => {
    // Locks the two-step add/drop migration (and its hand-fixed recreate copy,
    // a known drizzle-kit SQLite limitation) against a future regeneration that
    // names or shapes the reserved columns differently — per ADR 0005.
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);

    migrate(db, { migrationsFolder });

    const scheduleColumns = columnNames(sqlite, "schedules");
    expect(scheduleColumns).toEqual(
      expect.arrayContaining([
        "recurrence_days",
        "recurrence_start_minute",
        "recurrence_end_minute",
        "effective_from",
        "effective_to",
      ]),
    );
    // The never-defined free-text column is gone after the second migration.
    expect(scheduleColumns).not.toContain("cron_or_window");

    const exceptionColumns = columnNames(sqlite, "exceptions");
    expect(exceptionColumns).toContain("effective_from");
    // expires_at remains the effective end — no separate effective_to (ADR 0005 §2).
    expect(exceptionColumns).not.toContain("effective_to");

    sqlite.close();
  });

  it("is a no-op when re-applied to an already-migrated database", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);

    migrate(db, { migrationsFolder });
    const countAfterFirst = appliedMigrationCount(sqlite);

    expect(() => migrate(db, { migrationsFolder })).not.toThrow();
    // Re-applying must not record any additional migrations — the journal's
    // bookkeeping count is unchanged.
    expect(appliedMigrationCount(sqlite)).toBe(countAfterFirst);

    sqlite.close();
  });
});
