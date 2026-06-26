/**
 * Unit tests for the automatic pre-migration policy-store snapshot (#166).
 *
 * These drive the module directly against a real file-backed better-sqlite3
 * handle and fixture journals — no Drizzle migrator — so each behaviour (fresh
 * skip, no-pending skip, snapshot + retention, snapshot validity) is asserted in
 * isolation. The end-to-end wiring through `createDb` is covered in
 * `tests/policy/db.test.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backUpBeforeMigrate,
  inspectMigrations,
  pruneBackups,
  readJournalEntries,
} from "../../src/setup/pre-migration-backup.js";

/** A journal entry as it appears in `meta/_journal.json`. */
interface FixtureEntry {
  tag: string;
  when: number;
}

/** Write a fixture `meta/_journal.json` describing `entries` into `folder`. */
function writeJournal(folder: string, entries: FixtureEntry[]): void {
  mkdirSync(join(folder, "meta"), { recursive: true });
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: entries.map((entry, idx) => ({
        idx,
        version: "6",
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
}

describe("pre-migration-backup", () => {
  let dir: string;
  const openHandles = new Set<Database.Database>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-premig-"));
  });

  afterEach(() => {
    for (const handle of openHandles) handle.close();
    openHandles.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Open a tracked file-backed handle that afterEach will close. */
  function openDb(name = "policy.sqlite"): Database.Database {
    const handle = new Database(join(dir, name));
    openHandles.add(handle);
    return handle;
  }

  /** Stand up drizzle's bookkeeping table and apply the given `created_at`s. */
  function seedAppliedMigrations(db: Database.Database, createdAts: number[]): void {
    db.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
    );
    const insert = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
    for (const createdAt of createdAts) insert.run(`hash-${createdAt}`, createdAt);
  }

  describe("readJournalEntries", () => {
    it("parses and sorts entries ascending by `when`", () => {
      writeJournal(dir, [
        { tag: "0001_b", when: 2000 },
        { tag: "0000_a", when: 1000 },
      ]);

      const entries = readJournalEntries(dir);

      expect(entries.map((entry) => entry.tag)).toEqual(["0000_a", "0001_b"]);
    });
  });

  describe("inspectMigrations", () => {
    it("reports a fresh DB (no bookkeeping table) as never-migrated", () => {
      const db = openDb();
      writeJournal(dir, [{ tag: "0000_a", when: 1000 }]);

      expect(inspectMigrations(db, dir)).toEqual({
        everMigrated: false,
        appliedCount: 0,
        pendingTags: [],
      });
    });

    it("treats an empty bookkeeping table as never-migrated", () => {
      const db = openDb();
      seedAppliedMigrations(db, []);
      writeJournal(dir, [{ tag: "0000_a", when: 1000 }]);

      expect(inspectMigrations(db, dir).everMigrated).toBe(false);
    });

    it("reports pending tags as those newer than the latest applied", () => {
      const db = openDb();
      seedAppliedMigrations(db, [1000]);
      writeJournal(dir, [
        { tag: "0000_a", when: 1000 },
        { tag: "0001_b", when: 2000 },
        { tag: "0002_c", when: 3000 },
      ]);

      expect(inspectMigrations(db, dir)).toEqual({
        everMigrated: true,
        appliedCount: 1,
        pendingTags: ["0001_b", "0002_c"],
      });
    });

    it("reports no pending tags when the DB is already up to date", () => {
      const db = openDb();
      seedAppliedMigrations(db, [1000, 2000]);
      writeJournal(dir, [
        { tag: "0000_a", when: 1000 },
        { tag: "0001_b", when: 2000 },
      ]);

      expect(inspectMigrations(db, dir).pendingTags).toEqual([]);
    });
  });

  describe("pruneBackups", () => {
    it("keeps the newest N snapshots and deletes the rest", () => {
      const backups = join(dir, "backups");
      mkdirSync(backups);
      const names = [
        "pre-migrate-20260101T000000000Z.sqlite",
        "pre-migrate-20260102T000000000Z.sqlite",
        "pre-migrate-20260103T000000000Z.sqlite",
      ];
      for (const name of names) writeFileSync(join(backups, name), "x");
      // An unrelated file must be left alone.
      writeFileSync(join(backups, "notes.txt"), "x");

      const pruned = pruneBackups(backups, 2);

      expect(pruned).toEqual(["pre-migrate-20260101T000000000Z.sqlite"]);
      expect(readdirSync(backups).sort()).toEqual([
        "notes.txt",
        "pre-migrate-20260102T000000000Z.sqlite",
        "pre-migrate-20260103T000000000Z.sqlite",
      ]);
    });

    it("prunes nothing when at or under the retain count", () => {
      const backups = join(dir, "backups");
      mkdirSync(backups);
      writeFileSync(join(backups, "pre-migrate-20260101T000000000Z.sqlite"), "x");

      expect(pruneBackups(backups, 5)).toEqual([]);
    });

    it("returns nothing for a missing directory", () => {
      expect(pruneBackups(join(dir, "does-not-exist"), 3)).toEqual([]);
    });
  });

  describe("backUpBeforeMigrate", () => {
    const backupDir = (): string => join(dir, "backups");

    it("skips a fresh database", () => {
      const db = openDb();
      writeJournal(dir, [{ tag: "0000_a", when: 1000 }]);

      const result = backUpBeforeMigrate({
        client: db,
        migrationsFolder: dir,
        backupDir: backupDir(),
        retain: 5,
      });

      expect(result).toEqual({
        backedUp: false,
        pendingTags: [],
        pruned: [],
        skippedReason: "fresh-db",
      });
      expect(existsSync(backupDir())).toBe(false);
    });

    it("skips when no migrations are pending", () => {
      const db = openDb();
      seedAppliedMigrations(db, [1000]);
      writeJournal(dir, [{ tag: "0000_a", when: 1000 }]);

      const result = backUpBeforeMigrate({
        client: db,
        migrationsFolder: dir,
        backupDir: backupDir(),
        retain: 5,
      });

      expect(result.backedUp).toBe(false);
      expect(result.skippedReason).toBe("no-pending");
      expect(existsSync(backupDir())).toBe(false);
    });

    it("snapshots a consistent, pre-migration copy when migrations are pending", () => {
      const db = openDb();
      seedAppliedMigrations(db, [1000]);
      // Pre-migration content that the snapshot must capture.
      db.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
      db.prepare("INSERT INTO widgets (name) VALUES (?)").run("alpha");
      writeJournal(dir, [
        { tag: "0000_a", when: 1000 },
        { tag: "0001_b", when: 2000 },
      ]);

      const result = backUpBeforeMigrate({
        client: db,
        migrationsFolder: dir,
        backupDir: backupDir(),
        retain: 5,
        now: () => new Date("2026-06-20T09:15:00.123Z"),
      });

      expect(result.backedUp).toBe(true);
      expect(result.pendingTags).toEqual(["0001_b"]);
      expect(result.path).toBe(join(backupDir(), "pre-migrate-20260620T091500123Z.sqlite"));

      // The snapshot is a valid, standalone SQLite DB holding the captured row.
      const snapshot = new Database(result.path);
      openHandles.add(snapshot);
      expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok");
      const rows = snapshot.prepare("SELECT name FROM widgets").pluck().all();
      expect(rows).toEqual(["alpha"]);
    });

    it("retains only the newest N snapshots", () => {
      const db = openDb();
      seedAppliedMigrations(db, [1000]);
      writeJournal(dir, [
        { tag: "0000_a", when: 1000 },
        { tag: "0001_b", when: 2000 },
      ]);
      // Pre-seed two older snapshots, then take a third with retain=1 so the
      // new snapshot is the only survivor and both older ones are pruned.
      mkdirSync(backupDir());
      writeFileSync(join(backupDir(), "pre-migrate-20260101T000000000Z.sqlite"), "x");
      writeFileSync(join(backupDir(), "pre-migrate-20260102T000000000Z.sqlite"), "x");

      const result = backUpBeforeMigrate({
        client: db,
        migrationsFolder: dir,
        backupDir: backupDir(),
        retain: 1,
        now: () => new Date("2026-06-20T09:15:00.000Z"),
      });

      expect(result.pruned).toEqual([
        "pre-migrate-20260101T000000000Z.sqlite",
        "pre-migrate-20260102T000000000Z.sqlite",
      ]);
      const remaining = readdirSync(backupDir()).sort();
      expect(remaining).toEqual(["pre-migrate-20260620T091500000Z.sqlite"]);
    });

    it("throws when the snapshot cannot be written (caller decides best-effort)", () => {
      const db = openDb();
      seedAppliedMigrations(db, [1000]);
      writeJournal(dir, [
        { tag: "0000_a", when: 1000 },
        { tag: "0001_b", when: 2000 },
      ]);
      // Point backupDir at a path whose parent is a file, so mkdir/VACUUM fail.
      const filePath = join(dir, "not-a-dir");
      writeFileSync(filePath, "x");

      // Matched so the test can't pass for an unrelated reason: mkdir under a
      // file fails with ENOTDIR ("not a directory").
      expect(() =>
        backUpBeforeMigrate({
          client: db,
          migrationsFolder: dir,
          backupDir: join(filePath, "backups"),
          retain: 5,
        }),
      ).toThrow(/ENOTDIR|not a directory/i);
    });
  });
});
