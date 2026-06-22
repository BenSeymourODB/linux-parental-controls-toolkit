# Issue #166 — Automatic pre-migration DB backup

Phase 11. Before the in-process drizzle migrator runs on boot, snapshot
`policy.sqlite` so a failed or regretted migration on a server upgrade is
recoverable. Complements the manual `scripts/pct-data-backup.sh` (#120) by
applying the same "consistent SQLite snapshot" idea **automatically at the
highest-risk moment** — an upgrade that carries new migrations.

## Where it hooks in

`policy/db.ts` → `createDb()` is the single migrate-on-boot seam (#49): it opens
`settings.databaseUrl`, sets WAL + FK pragmas, then calls drizzle's
`better-sqlite3` migrator. The snapshot goes **between open and migrate**.

## Trigger logic (only the upgrade case)

- **Fresh / first-run DB** (no `__drizzle_migrations` table, or it has 0 rows):
  skip — there is nothing yet to protect.
- **Existing DB with no pending migrations** (every journal entry already
  applied): skip — boot applies nothing, so no snapshot needed.
- **Existing DB with ≥1 pending migration**: snapshot, then migrate.

"Pending" is computed from the committed migrations folder's
`meta/_journal.json` (`entries[].when`, validated with zod) vs. the max
`created_at` recorded in `__drizzle_migrations` — drizzle's own bookkeeping.
Append-only + ordered, so `when > maxApplied` is exactly drizzle's apply rule.

## Snapshot mechanism

`VACUUM INTO '<dest>'` on the open `better-sqlite3` handle — a transactionally
consistent, fully-checkpointed, standalone copy (issue calls for the SQLite
backup API / `VACUUM INTO`, **not** a raw file copy). Synchronous, so it fits
`createDb`'s synchronous flow. Destination:
`<backupDir>/pre-migrate-<UTCcompact>.sqlite`, where `backupDir` defaults to
`<dirname(databaseUrl)>/backups` (i.e. `/data/backups`).

## Retention

Keep the last N (`PCT_PRE_MIGRATION_BACKUP_RETAIN`, default 5). Prune older
`pre-migrate-*.sqlite` files after writing the new one (timestamped names sort
chronologically).

## Failure posture

- **Migration failure** stays the health gate: `migrate()` already rethrows and
  `createDb` closes the handle, so boot fails rather than serving a half-migrated
  DB. The just-written snapshot is kept (it's taken before migrate).
- **Snapshot failure** (e.g. unwritable `/data/backups`): best-effort — log
  loudly at `error` and proceed to migrate, matching the "start anyway, surface
  the error" posture of the SSH-keygen (#39) and AdGuard-preflight (#95) steps.
  Disabling via `PCT_PRE_MIGRATION_BACKUP=false` is available for operators who
  manage snapshots externally (e.g. dataset snapshots).

## Files

1. **`server/src/setup/pre-migration-backup.ts`** (new) — pure/injectable:
   - `readJournalEntries(folder)` — zod-validated `meta/_journal.json` reader.
   - `inspectMigrations(client, folder)` → `{ everMigrated, appliedCount, pendingTags }`.
   - `pruneBackups(dir, retain)` → deleted names.
   - `backUpBeforeMigrate(opts)` → `{ backedUp, path?, pendingTags, pruned, skippedReason? }`.
   - `MigrationBackupLogger` (info/warn/error; Fastify `app.log` satisfies it).
2. **`server/src/config.ts`** — `preMigrationBackup` block:
   `enabled` (`PCT_PRE_MIGRATION_BACKUP`, default true), `dir`
   (`PCT_PRE_MIGRATION_BACKUP_DIR`, optional → derived), `retain`
   (`PCT_PRE_MIGRATION_BACKUP_RETAIN`, positive int, default 5).
3. **`server/src/policy/db.ts`** — call `backUpBeforeMigrate` before `migrate`,
   gated on `enabled`; inner try/catch for best-effort; new `CreateDbOptions`
   seams (`log`, `backupDir`, `backUpBeforeMigrate`); accept optional
   `preMigrationBackup` on the settings param (back-compat with existing callers).
4. **`server/src/web/app.ts`** — pass `{ log: app.log }` into `createDb`.
5. **`docs/server-deployment.md`** — First-run step 1 (note the pre-migration
   snapshot), the Backup/restore section (auto vs manual), Upgrade path (recovery
   story), Volume layout (`backups/`). **`.env.example`** — the three new vars.

## Tests

- `server/tests/setup/pre-migration-backup.test.ts` — `inspectMigrations`
  (fresh / applied / pending), `pruneBackups` (retain N, oldest dropped, empty),
  `backUpBeforeMigrate` (fresh-skip, no-pending-skip, snapshot taken + snapshot
  is a valid SQLite DB holding pre-migration content + integrity_check ok,
  retention, snapshot-failure surfaces).
- `server/tests/policy/db.test.ts` — end-to-end via `createDb` with v1→v2
  fixture migration folders: snapshot written before applying the new migration,
  snapshot holds the pre-migration schema only, disabled flag suppresses it,
  fresh DB writes none.
- `server/tests/config.test.ts` — defaults + env overrides + validation.

## License boundary

Pure `node:fs` + `better-sqlite3` (MIT) + zod. No GPL surface, no new
dependency, no Docker-image change. `license-guard` unaffected.

## Deferred

- Surfacing snapshot state in the admin UI and the Phase-14 server self-update
  runbook (#173) — out of scope here (no admin shell hook for it yet).
