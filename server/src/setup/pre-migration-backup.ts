/**
 * Automatic pre-migration policy-store snapshot (#166).
 *
 * The dashboard applies its schema migrations **in-process on boot** (#49,
 * `policy/db.ts`). On a server upgrade that ships new migrations, that is the
 * single highest-risk moment for the canonical policy store: a failed or
 * regretted migration can leave the data unrecoverable on the current
 * `docker pull` + restart upgrade path. This module snapshots `policy.sqlite`
 * **before** the migrator runs, so an upgrade is always recoverable.
 *
 * It is the automatic counterpart to the manual `scripts/pct-data-backup.sh`
 * (#120): the same "consistent SQLite snapshot, never a hot `cp`" idea, applied
 * at boot only when migrations are actually pending. The snapshot uses
 * `VACUUM INTO`, which writes a transactionally-consistent, fully-checkpointed,
 * standalone copy of the live database.
 *
 * License boundary: none touched. Pure `node:fs` + the in-process
 * `better-sqlite3` (MIT) handle + zod; no GPL component, no subprocess, no
 * `sqlite3` binary added to the image (the migrate-on-boot model deliberately
 * keeps DB work in-process — see `policy/db.ts`).
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { z } from "zod";

/** drizzle-orm's own bookkeeping table; its rows are the applied migrations. */
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";

/** Snapshot file name parts: `pre-migrate-<UTCcompact>.sqlite`. */
const BACKUP_PREFIX = "pre-migrate-";
const BACKUP_SUFFIX = ".sqlite";

/**
 * The fields of `meta/_journal.json` this module reads. drizzle writes more
 * (`version`, `breakpoints`); zod strips the rest. `when` is the migration's
 * folder-millis timestamp — the value drizzle records as `created_at` when it
 * applies the migration, and the key it orders + gates application on.
 */
const journalSchema = z.object({
  entries: z
    .array(
      z.object({
        idx: z.number(),
        when: z.number(),
        tag: z.string(),
      }),
    )
    .default([]),
});

/** A parsed `meta/_journal.json` migration entry. */
export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Read and validate the committed migration journal.
 *
 * The journal is repo-controlled, but it crosses a filesystem boundary into
 * typed code, so it is zod-validated like any other external input
 * (`CLAUDE.md` → conventions). Entries are returned in ascending `when` order.
 */
export function readJournalEntries(migrationsFolder: string): JournalEntry[] {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const raw = readFileSync(journalPath, "utf8");
  const parsed = journalSchema.parse(JSON.parse(raw) as unknown);
  return [...parsed.entries].sort((a, b) => a.when - b.when);
}

/** The migration state of an opened, not-yet-migrated database. */
export interface MigrationState {
  /** True iff this DB has already had ≥1 migration applied (an existing store). */
  everMigrated: boolean;
  /** Number of rows in `__drizzle_migrations` (0 when the table is absent). */
  appliedCount: number;
  /** Tags of journal entries not yet applied to this DB, ascending by `when`. */
  pendingTags: string[];
}

/** `SELECT count(*)` / `max(...)` scalar row shapes. */
const countRowSchema = z.object({ c: z.number() });
const maxRowSchema = z.object({ m: z.number().nullable() });

/**
 * Inspect an opened (pre-migrate) handle against the committed migrations
 * folder to decide whether a snapshot is warranted.
 *
 * A DB with no `__drizzle_migrations` table — or the table present but empty —
 * is a fresh / first-run store with nothing yet to protect (`everMigrated:
 * false`). Otherwise "pending" is every journal entry whose `when` is newer than
 * the latest applied `created_at`. This mirrors drizzle's own apply rule for the
 * normal append-only journal: its migrator compares each entry's `when`
 * (`folderMillis`) against the single most-recent applied `created_at`. A
 * hand-edited or otherwise out-of-band DB state (a "hole" below the max) is not
 * specially reconciled here — `pendingTags` is a best-effort, human-facing
 * summary, not an authoritative replay plan.
 */
export function inspectMigrations(
  client: Database.Database,
  migrationsFolder: string,
): MigrationState {
  const tableExists = client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(DRIZZLE_MIGRATIONS_TABLE);

  if (tableExists === undefined) {
    return { everMigrated: false, appliedCount: 0, pendingTags: [] };
  }

  const appliedCount = countRowSchema.parse(
    client.prepare(`SELECT count(*) AS c FROM ${DRIZZLE_MIGRATIONS_TABLE}`).get(),
  ).c;

  if (appliedCount === 0) {
    return { everMigrated: false, appliedCount: 0, pendingTags: [] };
  }

  const maxApplied = maxRowSchema.parse(
    client.prepare(`SELECT max(created_at) AS m FROM ${DRIZZLE_MIGRATIONS_TABLE}`).get(),
  ).m;

  const entries = readJournalEntries(migrationsFolder);
  const pendingTags = entries
    .filter((entry) => maxApplied === null || entry.when > maxApplied)
    .map((entry) => entry.tag);

  return { everMigrated: true, appliedCount, pendingTags };
}

/** A compact, lexically-sortable UTC stamp: `20260620T091500123Z`. */
function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** Single-quote a path for use as a SQLite string literal in `VACUUM INTO`. */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Delete all but the newest `retain` `pre-migrate-*.sqlite` files in `dir`.
 *
 * Names are timestamp-prefixed, so a lexical sort is chronological. Returns the
 * names that were pruned (oldest first). A missing directory prunes nothing.
 */
export function pruneBackups(dir: string, retain: number): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const snapshots = names
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .sort();

  const keep = Math.max(0, retain);
  const excess = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const name of excess) {
    rmSync(join(dir, name), { force: true });
  }
  return excess;
}

/** Minimal structural logger (Fastify's `app.log` satisfies it). */
export interface MigrationBackupLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/** Options for {@link backUpBeforeMigrate}. */
export interface PreMigrationBackupOptions {
  /** The opened, pre-migrate better-sqlite3 handle. */
  client: Database.Database;
  /** The committed migrations folder (matches what the migrator will use). */
  migrationsFolder: string;
  /** Directory the snapshot is written into (created if absent). */
  backupDir: string;
  /** Number of snapshots to keep; older ones are pruned. */
  retain: number;
  /** Clock seam; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Optional logger for the snapshot/skip outcome. */
  log?: MigrationBackupLogger;
}

/** Outcome of {@link backUpBeforeMigrate}. */
export interface PreMigrationBackupResult {
  /** True iff a snapshot file was written on this call. */
  backedUp: boolean;
  /** Absolute path of the snapshot, when one was written. */
  path?: string;
  /** Tags of the migrations that prompted the snapshot. */
  pendingTags: string[];
  /** Names of older snapshots pruned by retention. */
  pruned: string[];
  /** Why no snapshot was written, when {@link backedUp} is false. */
  skippedReason?: "fresh-db" | "no-pending";
}

/**
 * Snapshot the policy store before migrations run, if (and only if) migrations
 * are pending against an already-migrated database.
 *
 * Throws only on a genuine snapshot failure (e.g. an unwritable backup
 * directory). The caller in `createDb` treats that as best-effort — it logs and
 * still migrates, because the migrator's own failure is the real boot health
 * gate — but the throw is surfaced so that decision lives in one place.
 */
export function backUpBeforeMigrate(options: PreMigrationBackupOptions): PreMigrationBackupResult {
  const { client, migrationsFolder, backupDir, retain, log } = options;
  const now = options.now ?? (() => new Date());

  const state = inspectMigrations(client, migrationsFolder);

  if (!state.everMigrated) {
    log?.info({}, "pre-migration backup: fresh database, nothing to snapshot");
    return { backedUp: false, pendingTags: [], pruned: [], skippedReason: "fresh-db" };
  }
  if (state.pendingTags.length === 0) {
    log?.info({}, "pre-migration backup: no pending migrations, nothing to snapshot");
    return { backedUp: false, pendingTags: [], pruned: [], skippedReason: "no-pending" };
  }

  mkdirSync(backupDir, { recursive: true });
  const destination = join(backupDir, `${BACKUP_PREFIX}${backupStamp(now())}${BACKUP_SUFFIX}`);

  // VACUUM INTO writes a transactionally-consistent, fully-checkpointed,
  // standalone copy — safe on a WAL database and far safer than a hot file copy.
  client.exec(`VACUUM INTO ${sqlStringLiteral(destination)}`);

  const pruned = pruneBackups(backupDir, retain);

  log?.warn(
    { path: destination, pendingTags: state.pendingTags, pruned },
    "pre-migration backup: snapshotted policy store before applying pending migrations",
  );

  return { backedUp: true, path: destination, pendingTags: state.pendingTags, pruned };
}
