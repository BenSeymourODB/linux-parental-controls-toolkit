# Plan — #120: backup/restore utility for the data volume

Roadmap: `docs/roadmap.md` → Phase 11 ("Backup/restore utility script").

## Goal

A `scripts/` utility that snapshots and restores the persistent `/data`
volume, using a **consistent SQLite backup** (not a hot file copy), covering
only the non-regenerable state and documenting the rest.

## Data-volume layout (`docs/server-deployment.md` → "Volume layout")

```
/data
├── policy.sqlite     # canonical policy store        -> IN SCOPE (consistent snapshot)
├── secrets/          # ssh keys, api-keys.env         -> IN SCOPE (verbatim, perms preserved)
│   ├── ssh/
│   └── api-keys.env
├── ansible/
│   ├── venv/         # pip-installed on first run      -> EXCLUDE (regenerable)
│   ├── inventory.yml # deployment config               -> IN SCOPE
│   └── playbooks/    # synced from image               -> EXCLUDE (regenerable)
├── adguard/
│   ├── AdGuardHome   # binary fetched from upstream     -> EXCLUDE (regenerable)
│   └── conf/         # managed-mode config the dashboard owns -> IN SCOPE
└── logs/             # runtime logs                     -> EXCLUDE (not state)
```

## Deliverable

`scripts/pct-data-backup.sh` with two subcommands:

- `backup  [--data-dir DIR] [--output FILE] [--quiet]`
- `restore [--data-dir DIR] [--force] ARCHIVE`

`--data-dir` defaults to `${PCT_DATA_DIR:-/data}`.

### backup
1. Preflight: data-dir is a directory; `tar`/`gzip` present; `sqlite3` present
   iff `policy.sqlite` exists.
2. Stage in a `mktemp -d` (trap-cleaned). Layout: `MANIFEST` + `data/…`.
3. `policy.sqlite` → `sqlite3 "$db" ".backup '$stage'"` (online backup, safe
   while in use), then `PRAGMA integrity_check` the snapshot — fail loudly if
   not `ok`.
4. `cp -a` the in-scope `secrets/`, `adguard/conf/`, `ansible/inventory.yml`
   that exist (perms preserved).
5. Write `MANIFEST` (tool + format version, UTC timestamp, source dir, included
   entries, integrity result).
6. `tar -czf "$OUTPUT" -C "$stage" .`; `chmod 600` the archive (holds secrets).

### restore
1. Preflight: archive readable; `tar` present.
2. Extract to `mktemp -d`; require `MANIFEST` (format-version match) + `data/`.
3. Safety: refuse a non-empty target `--data-dir` without `--force` (tell the
   admin to stop the container first).
4. `cp -a $tmp/data/.` into the data-dir (perms preserved); integrity-check a
   restored `policy.sqlite`.

## Tests — `scripts/tests/pct-data-backup.bats`

Round-trip (DB rows survive, incl. WAL mode), secrets perms preserved
(0600/0700), regenerable paths excluded, restore `--force` guard, missing
policy.sqlite (fresh deploy) still produces an archive, missing-archive and
bad-subcommand error exits, help text.

## Docs / CI
- Rewrite `docs/server-deployment.md` → "Backup and restore" to point at the
  script and spell out in-scope vs regenerable + the stop-container step.
- Extend CI `shellcheck` job to cover `scripts/`; generalise the bats job to
  also run `scripts/tests/` (install `sqlite3`).

## License boundary
N/A — a standalone POSIX/bash utility shelling out to `sqlite3`/`tar`. No GPL
code linked, no GPL binary added to any image, no transport/REST boundary.

## Deferred (tracked)
- Automatic pre-migration DB snapshot on boot → **#166** (builds on this).
