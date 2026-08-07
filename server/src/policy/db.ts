/**
 * Live policy-store connection (better-sqlite3 + Drizzle).
 *
 * This is the runtime counterpart to the in-memory `testDb()` helper
 * (`tests/helpers/db.ts`, #12): where that opens a hermetic `:memory:`
 * database for unit tests, `createDb()` opens the real file the dashboard
 * persists to (`settings.databaseUrl`) and hands the app one shared Drizzle
 * handle (#49). The CRUD routes (#51) and auth (#52) read and write through
 * this single connection.
 *
 * **Migrate-on-boot, in-process.** `createDb()` applies the committed
 * migrations under `server/drizzle/` with drizzle-orm's `better-sqlite3`
 * migrator. The migrator runs in-process at server start rather than from
 * `docker-entrypoint.sh`, so the runtime image never ships `drizzle-kit` (a
 * dev dependency) — see the Phase-2 note on #39 and
 * `docs/server-deployment.md` → "First-run setup". The migrator is
 * idempotent (it tracks applied migrations in its own `__drizzle_migrations`
 * journal), so re-running it on an already-migrated file is a no-op and there
 * is no double-migration hazard.
 *
 * License boundary: better-sqlite3 (MIT) and drizzle-orm (Apache-2.0) are
 * permissively licensed and linked in-process freely; no GPL component is
 * involved here.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { Settings } from "../config.js";
import {
  backUpBeforeMigrate as defaultBackUpBeforeMigrate,
  type MigrationBackupLogger,
} from "../setup/pre-migration-backup.js";
import * as schema from "./schema.js";

/**
 * The committed migrations folder, resolved relative to this module rather
 * than the process cwd. From `src/policy/` (tests, run from TypeScript) and
 * from `dist/policy/` (the image, where the Dockerfile copies `drizzle/` to
 * `/app/drizzle`) this is the same `<root>/drizzle` directory — the same
 * approach `tests/helpers/db.ts` and `tests/policy/migrations.test.ts` use.
 */
const DEFAULT_MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * A migrated, file-backed Drizzle database, typed against the full policy
 * {@link schema}. The underlying better-sqlite3 handle is reachable via
 * `.$client` (e.g. `db.$client.close()` on shutdown) — mirroring `TestDb`.
 */
export type PolicyDb = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

/**
 * A transaction handle over the policy store — the argument drizzle hands the
 * `db.transaction((tx) => …)` callback. Structurally a {@link PolicyDb} without
 * the `$client` escape hatch, so a write helper that must run either directly
 * or inside a transaction takes `PolicyDb | PolicyTx` and callers can pass
 * either the db or a `tx`.
 */
export type PolicyTx = Parameters<Parameters<PolicyDb["transaction"]>[0]>[0];

/** Options for {@link createDb}. */
export interface CreateDbOptions {
  /**
   * Override the migrations folder. Defaults to the committed `server/drizzle`
   * resolved relative to this module; tests point it at a fixture when needed.
   */
  migrationsFolder?: string;
  /**
   * Optional logger for boot-time steps — currently the pre-migration backup
   * (#166). `buildApp` passes `app.log`; tests may capture or omit it.
   */
  log?: MigrationBackupLogger;
  /**
   * Override the directory the pre-migration snapshot is written into. Defaults
   * to `settings.preMigrationBackup.dir`, else `<dirname(databaseUrl)>/backups`.
   */
  backupDir?: string;
  /**
   * Test seam for the pre-migration backup runner. Defaults to the real
   * `VACUUM INTO` snapshot in `setup/pre-migration-backup.ts`.
   */
  backUpBeforeMigrate?: typeof defaultBackUpBeforeMigrate;
}

/** Pre-migration backup settings, with a safe default when a caller omits them. */
type DbSettings = Pick<Settings, "databaseUrl"> & Partial<Pick<Settings, "preMigrationBackup">>;

/** Defaults applied when a caller passes no `preMigrationBackup` block. */
const DEFAULT_BACKUP_SETTINGS: Settings["preMigrationBackup"] = { enabled: true, retain: 5 };

/**
 * Open the policy store at `settings.databaseUrl`, apply migrations, and
 * return a typed Drizzle handle.
 *
 * `databaseUrl` is already a bare filesystem path: the settings loader (#34)
 * strips any leading `file:` so drizzle-kit and the runtime always open the
 * same file. WAL is enabled so reads don't block the dashboard's writes, and
 * `foreign_keys` is turned on (SQLite leaves it off per-connection by default)
 * so the schema's referential integrity is actually enforced at runtime.
 */
export function createDb(settings: DbSettings, options: CreateDbOptions = {}): PolicyDb {
  const sqlite = new Database(settings.databaseUrl);
  // WAL: concurrent readers don't block the writer (the dashboard reads usage
  // while pushing policy). foreign_keys: SQLite defaults this OFF per
  // connection, so the schema's FK constraints only bite once we set it.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db: PolicyDb = drizzle(sqlite, { schema });
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const backup = settings.preMigrationBackup ?? DEFAULT_BACKUP_SETTINGS;

  try {
    // Snapshot the store before applying any pending migration (#166), so a
    // regretted upgrade is recoverable. Best-effort: a snapshot failure (e.g. an
    // unwritable backups dir) is logged loudly but does not block boot — the
    // migrate() below remains the health gate that refuses to serve a
    // half-migrated DB. A fresh / up-to-date DB is a no-op.
    if (backup.enabled) {
      const runBackup = options.backUpBeforeMigrate ?? defaultBackUpBeforeMigrate;
      const backupDir =
        options.backupDir ?? backup.dir ?? join(dirname(settings.databaseUrl), "backups");
      try {
        runBackup({
          client: sqlite,
          migrationsFolder,
          backupDir,
          retain: backup.retain,
          // Only set `log` when present (exactOptionalPropertyTypes).
          ...(options.log ? { log: options.log } : {}),
        });
      } catch (err) {
        options.log?.error(
          { err },
          "pre-migration backup failed; proceeding with migration without a snapshot",
        );
      }
    }

    migrate(db, { migrationsFolder });
  } catch (err) {
    // Don't leak the open handle if migration fails (corrupt/locked file).
    sqlite.close();
    throw err;
  }

  return db;
}
