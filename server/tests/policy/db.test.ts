/**
 * Tests for the live policy-store connection {@link createDb} (#49).
 *
 * Unlike the in-memory `testDb()` helper, these exercise a real file-backed
 * database in a temp dir: WAL mode is only meaningful on disk, and reopening
 * the same file is what proves migrate-on-boot is idempotent. Each test gets
 * its own temp directory and closes the handle so nothing leaks between runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type PolicyDb } from "../../src/policy/db.js";
import { users } from "../../src/policy/schema.js";

describe("createDb", () => {
  let dir: string;
  let dbPath: string;
  const open = new Set<PolicyDb>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-db-"));
    dbPath = join(dir, "policy.sqlite");
  });

  afterEach(() => {
    for (const db of open) db.$client.close();
    open.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Open a tracked handle so afterEach always closes it (and frees the file). */
  function openDb(path = dbPath): PolicyDb {
    const db = createDb({ databaseUrl: path });
    open.add(db);
    return db;
  }

  /** Read a SQLite PRAGMA's scalar value off the underlying handle. */
  function pragma(db: PolicyDb, name: string): unknown {
    return db.$client.pragma(name, { simple: true });
  }

  it("creates the database file and materialises the full policy schema", () => {
    const db = openDb();

    const tableNames = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
          "AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
      )
      .pluck()
      .all();

    expect(tableNames).toContain("users");
    expect(tableNames).toContain("grants");
    expect(tableNames).toContain("notification_policies");
  });

  it("enables WAL journaling and foreign-key enforcement", () => {
    const db = openDb();

    // WAL is only honoured on a file-backed database, which is why this test
    // uses a temp file rather than the in-memory testDb() helper.
    expect(String(pragma(db, "journal_mode")).toLowerCase()).toBe("wal");
    expect(pragma(db, "foreign_keys")).toBe(1);
  });

  it("enforces foreign keys at runtime", () => {
    const db = openDb();

    // users_on_clients.user_id / client_id are NOT NULL FKs; with
    // foreign_keys=ON, inserting a row referencing absent parents must throw.
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO users_on_clients (user_id, client_id, linux_username, linux_uid) " +
            "VALUES (999, 999, 'ghost', 1000)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("round-trips a row through the typed Drizzle handle", () => {
    const db = openDb();

    db.insert(users).values({ displayName: "Alice" }).run();
    const rows = db.select().from(users).all();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("Alice");
    // tz defaults to NULL ("inherit the server default"); createdAt is set.
    expect(rows[0]?.tz).toBeNull();
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("propagates a migration failure instead of returning a half-open handle", () => {
    // Point at a folder with no migration journal so the migrator throws; the
    // open sqlite handle is closed in createDb's catch rather than leaked.
    expect(() =>
      createDb({ databaseUrl: dbPath }, { migrationsFolder: join(dir, "no-such-migrations") }),
    ).toThrow();
  });

  it("is idempotent: reopening an existing file re-applies no migrations and keeps data", () => {
    const first = openDb();
    first.insert(users).values({ displayName: "Bob" }).run();
    const appliedAfterFirst = first.$client
      .prepare("SELECT count(*) FROM __drizzle_migrations")
      .pluck()
      .get();
    first.$client.close();
    open.delete(first);

    // Reopen the same path: migrate-on-boot must be a no-op (same journal
    // count) and the previously written row must still be there.
    const second = openDb();
    const appliedAfterSecond = second.$client
      .prepare("SELECT count(*) FROM __drizzle_migrations")
      .pluck()
      .get();

    expect(appliedAfterSecond).toBe(appliedAfterFirst);
    expect(second.select().from(users).all()).toHaveLength(1);
  });
});
