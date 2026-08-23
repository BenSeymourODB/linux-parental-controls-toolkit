# How to recover from a backup

The whole deployable state lives under the `/data` volume, and most of it
is **regenerated on first run** (the Ansible venv, the synced playbooks, the
AdGuard Home binary). A backup therefore captures only the
**non-regenerable** state, and the policy store must be captured
*consistently* — a hot copy of a live SQLite file can restore to
corruption. This guide covers the two restore paths; the design and the
full path-by-path table are in
[`server-deployment.md`](../server-deployment.md) → "Backup and restore".

There are two independent safety nets:

1. **Manual backups** you take with `scripts/pct-data-backup.sh`.
2. **Automatic pre-migration snapshots** the dashboard takes on boot,
   before applying any new schema migration.

## Take a manual backup

`scripts/pct-data-backup.sh` snapshots `policy.sqlite` through SQLite's
online backup API (safe even while the dashboard is running) and packs the
non-regenerable state into one owner-only `tar.gz`. The host needs
`sqlite3` and `tar` on its `PATH`.

```bash
# Archive defaults to ./pct-data-backup-<UTC>.tar.gz
scripts/pct-data-backup.sh backup \
    --data-dir /data \
    --output /backups/pct-$(date -u +%F).tar.gz
```

What lands in the archive: `policy.sqlite` (consistent snapshot),
`secrets/` (SSH key + API keys, permissions preserved), `adguard/conf/`
(managed-mode config, if present), and `ansible/inventory.yml` (if
present). The regenerable siblings — the Ansible venv, the synced
playbooks, and the AdGuard Home binary — are deliberately left out.

> Losing `secrets/` means losing the SSH key every client authorized, so
> you would have to re-enrol the fleet. Keep the backups somewhere durable.

## Restore a manual backup

Stop the dashboard first so nothing is writing `/data`, then restore and
start it again — first-run setup re-creates the regenerable pieces.

```bash
docker compose stop dashboard
scripts/pct-data-backup.sh restore \
    --data-dir /data \
    --force \
    /backups/pct-2026-06-19.tar.gz
docker compose start dashboard   # re-creates the venv / AdGuard binary
```

- Restore **refuses a non-empty `--data-dir` without `--force`**, so it
  can't clobber a live deployment by accident.
- With `--force` it **replaces** the in-scope paths wholesale
  (`policy.sqlite` and its WAL/SHM sidecars, `secrets/`, `adguard/conf/`,
  `ansible/inventory.yml`) rather than merging — so the restore reproduces
  exactly the backed-up state and never resurrects a rotated key or a stale
  WAL — and leaves the regenerable siblings untouched.
- It then re-runs `PRAGMA integrity_check` on the restored database.

If your storage does volume-level snapshots (e.g. TrueNAS SCALE dataset
snapshots of `pct_data`), those are a valid coarse backup — but take them
with the container **stopped**, since they copy `policy.sqlite` at the file
level rather than through the SQLite backup API.

## Recover from a failed upgrade (pre-migration snapshot)

When you `docker pull` a newer image that ships schema migrations, the
dashboard automatically snapshots `policy.sqlite` with SQLite's `VACUUM
INTO` **before** applying any pending migration, writing it to
`/data/backups/pre-migrate-<UTC>.sqlite`. A fresh or already-current
database is skipped. The last `PCT_PRE_MIGRATION_BACKUP_RETAIN` snapshots
(default `5`) are kept.

If a migration fails, the dashboard **does not serve a half-migrated
database** — it logs the failure and exits, leaving the snapshot in place.
To recover, restore the named snapshot and start the **previous** image
tag:

```bash
docker compose stop dashboard
# Restore a specific pre-migration snapshot as the policy store:
cp /data/backups/pre-migrate-20260620T091500123Z.sqlite /data/policy.sqlite
rm -f /data/policy.sqlite-wal /data/policy.sqlite-shm   # drop stale sidecars
# Pin docker-compose back to the previous image tag, then:
docker compose start dashboard
```

The behaviour is controlled by `PCT_PRE_MIGRATION_BACKUP` (default `true`),
`PCT_PRE_MIGRATION_BACKUP_DIR` (default `/data/backups`), and
`PCT_PRE_MIGRATION_BACKUP_RETAIN` (default `5`). Snapshotting is
best-effort: if it cannot write, the dashboard logs the error loudly and
still migrates, so disable it only if you snapshot `/data` externally.
