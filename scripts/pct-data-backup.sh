#!/usr/bin/env bash
#
# pct-data-backup.sh — back up and restore the dashboard's persistent state.
#
# The entire deployable state of the dashboard lives under the mounted data
# volume (`/data`, see docs/server-deployment.md → "Volume layout"). This
# utility snapshots the *non-regenerable* parts of it into a single gzipped tar
# archive and restores them again, so a regretted upgrade, a failed migration,
# or a host move is recoverable.
#
# The policy store (`policy.sqlite`) is captured with SQLite's **online backup**
# (`sqlite3 ... ".backup"`), not a raw file copy: a hot `cp` of a live SQLite
# file can capture a torn page or miss a WAL that has not been checkpointed,
# yielding a corrupt restore. The online backup produces a transactionally
# consistent snapshot even while the dashboard is running.
#
# What is backed up (non-regenerable state):
#   policy.sqlite          the canonical policy store        (consistent snapshot)
#   secrets/               SSH keys + api-keys.env           (verbatim, perms kept)
#   adguard/conf/          AdGuard managed-mode config        (if present)
#   ansible/inventory.yml  the dashboard's Ansible inventory  (if present)
#
# What is deliberately *excluded* (regenerated on first run, per
# docs/server-deployment.md → "First-run setup"):
#   ansible/venv/          pip-installed on boot
#   ansible/playbooks/     synced from the image on boot
#   adguard/AdGuardHome    binary refetched from upstream on boot
#   logs/                  runtime logs, not state
#
# License boundary: this is a standalone shell utility that shells out to
# `sqlite3`/`tar`. It links no GPL code in-process and adds no GPL binary to any
# image (docs/licensing-analysis.md); SQLite is public-domain.
#
# Usage:
#   pct-data-backup.sh backup  [--data-dir DIR] [--output FILE] [--quiet]
#   pct-data-backup.sh restore [--data-dir DIR] [--force] [--quiet] ARCHIVE
#
# --data-dir defaults to ${PCT_DATA_DIR:-/data}. For backup, --output defaults
# to ./pct-data-backup-<UTC-timestamp>.tar.gz.
#
set -euo pipefail

# The archive format version. Bump only on an incompatible layout change so a
# restore can refuse an archive it does not understand rather than scattering
# files. The MANIFEST records the value a given archive was written with.
readonly MANIFEST_FORMAT_VERSION="1"
readonly PROG="${0##*/}"

# In-scope, non-regenerable entries, relative to the data dir. Order is the
# order they are staged and reported.
readonly IN_SCOPE_FILES=("policy.sqlite" "ansible/inventory.yml")
readonly IN_SCOPE_DIRS=("secrets" "adguard/conf")

DATA_DIR="${PCT_DATA_DIR:-/data}"
QUIET=0

log() {
  [ "$QUIET" -eq 1 ] && return 0
  printf '%s\n' "$*" >&2
}

err() {
  printf '%s: error: %s\n' "$PROG" "$*" >&2
}

die() {
  err "$*"
  exit 1
}

usage() {
  cat <<EOF
$PROG — back up and restore the dashboard's /data volume.

Usage:
  $PROG backup  [--data-dir DIR] [--output FILE] [--quiet]
  $PROG restore [--data-dir DIR] [--force] [--quiet] ARCHIVE

Subcommands:
  backup    Snapshot the non-regenerable state under DIR into a tar.gz archive.
  restore   Restore a backup archive into DIR.

Options:
  --data-dir DIR   The data volume root (default: \${PCT_DATA_DIR:-/data}).
  --output FILE    backup: archive path (default: ./pct-data-backup-<UTC>.tar.gz).
  --force          restore: overwrite a non-empty data dir (stop the container first).
  --quiet          Suppress progress output.
  -h, --help       Show this help.

Backed up:  policy.sqlite (consistent snapshot), secrets/, adguard/conf/,
            ansible/inventory.yml.
Excluded (regenerated on first run): ansible/venv/, ansible/playbooks/,
            adguard/AdGuardHome, logs/.
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH"
}

# A directory is "non-empty" if it contains any entry (including dotfiles).
dir_is_nonempty() {
  local d="$1"
  [ -d "$d" ] || return 1
  find "$d" -mindepth 1 -print -quit 2>/dev/null | read -r _
}

# --- backup ----------------------------------------------------------------

cmd_backup() {
  local output=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --data-dir)
        [ $# -ge 2 ] || die "--data-dir requires a value"
        DATA_DIR="$2"
        shift 2
        ;;
      --output)
        [ $# -ge 2 ] || die "--output requires a value"
        output="$2"
        shift 2
        ;;
      --quiet)
        QUIET=1
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      -*) die "unknown option for backup: $1" ;;
      *) die "unexpected argument for backup: $1" ;;
    esac
  done

  [ -d "$DATA_DIR" ] || die "data dir '$DATA_DIR' does not exist or is not a directory"
  require_cmd tar
  require_cmd gzip

  if [ -z "$output" ]; then
    output="pct-data-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  fi

  local stage data_stage
  stage="$(mktemp -d "${TMPDIR:-/tmp}/pct-backup.XXXXXX")"
  # shellcheck disable=SC2064 # expand $stage now so the trap captures this dir
  trap "rm -rf '$stage'" EXIT
  data_stage="$stage/data"
  mkdir -p "$data_stage"

  local integrity="skipped (no policy.sqlite)"
  local -a included=()

  local db="$DATA_DIR/policy.sqlite"
  if [ -f "$db" ]; then
    require_cmd sqlite3
    log "Snapshotting policy.sqlite (consistent online backup)…"
    # ".backup" takes an online, transactionally consistent snapshot — safe even
    # while the dashboard holds the DB open. Single-quote the destination inside
    # the dot-command; the staging path is a mktemp dir with no quotes.
    sqlite3 "$db" ".backup '$data_stage/policy.sqlite'" \
      || die "sqlite3 online backup of '$db' failed"
    integrity="$(sqlite3 "$data_stage/policy.sqlite" 'PRAGMA integrity_check;' 2>/dev/null || true)"
    [ "$integrity" = "ok" ] || die "snapshot failed integrity_check (got: ${integrity:-<empty>})"
    included+=("policy.sqlite")
  else
    log "No policy.sqlite under '$DATA_DIR' — backing up the rest (fresh deploy?)."
  fi

  local rel
  for rel in "${IN_SCOPE_DIRS[@]}"; do
    if [ -d "$DATA_DIR/$rel" ]; then
      mkdir -p "$data_stage/$(dirname "$rel")"
      cp -a "$DATA_DIR/$rel" "$data_stage/$rel"
      included+=("$rel/")
    fi
  done
  for rel in "${IN_SCOPE_FILES[@]}"; do
    # policy.sqlite is handled above via the consistent snapshot.
    [ "$rel" = "policy.sqlite" ] && continue
    if [ -f "$DATA_DIR/$rel" ]; then
      mkdir -p "$data_stage/$(dirname "$rel")"
      cp -a "$DATA_DIR/$rel" "$data_stage/$rel"
      included+=("$rel")
    fi
  done

  {
    printf 'pct-data-backup manifest\n'
    printf 'format_version: %s\n' "$MANIFEST_FORMAT_VERSION"
    printf 'created_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'source_data_dir: %s\n' "$DATA_DIR"
    printf 'sqlite_integrity_check: %s\n' "$integrity"
    printf 'included:\n'
    if [ "${#included[@]}" -eq 0 ]; then
      printf '  (nothing — data dir held no in-scope state)\n'
    else
      for rel in "${included[@]}"; do printf '  - %s\n' "$rel"; done
    fi
  } >"$stage/MANIFEST"

  # Pack from the staging root so the archive contains ./MANIFEST and ./data/…
  # regardless of the data dir's absolute path. The archive embeds secrets/, so
  # write it under a tight umask (born 0600, never briefly world-readable) and
  # belt-and-suspenders chmod in case $output pre-existed with looser perms.
  (umask 077 && tar -czf "$output" -C "$stage" .) \
    || die "failed to write archive '$output'"
  chmod 600 "$output"

  log "Wrote backup: $output"
  log "Included: ${included[*]:-<none>}"
  printf '%s\n' "$output"
}

# --- restore ---------------------------------------------------------------

cmd_restore() {
  local force=0 archive=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --data-dir)
        [ $# -ge 2 ] || die "--data-dir requires a value"
        DATA_DIR="$2"
        shift 2
        ;;
      --force)
        force=1
        shift
        ;;
      --quiet)
        QUIET=1
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      -*) die "unknown option for restore: $1" ;;
      *)
        [ -z "$archive" ] || die "restore takes a single ARCHIVE argument"
        archive="$1"
        shift
        ;;
    esac
  done

  [ -n "$archive" ] || die "restore requires an ARCHIVE argument (see --help)"
  [ -f "$archive" ] || die "archive '$archive' does not exist or is not a file"
  require_cmd tar

  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pct-restore.XXXXXX")"
  # shellcheck disable=SC2064 # expand $tmp now so the trap captures this dir
  trap "rm -rf '$tmp'" EXIT

  tar -xzf "$archive" -C "$tmp" || die "failed to extract '$archive'"

  [ -f "$tmp/MANIFEST" ] || die "'$archive' is not a pct-data-backup archive (no MANIFEST)"
  [ -d "$tmp/data" ] || die "'$archive' has no data/ payload — refusing to restore"

  local fmt
  fmt="$(sed -n 's/^format_version: //p' "$tmp/MANIFEST" | head -n1)"
  [ "$fmt" = "$MANIFEST_FORMAT_VERSION" ] \
    || die "archive format_version '${fmt:-<missing>}' != supported '$MANIFEST_FORMAT_VERSION'"

  if dir_is_nonempty "$DATA_DIR" && [ "$force" -eq 0 ]; then
    die "data dir '$DATA_DIR' is not empty; stop the dashboard, then re-run with --force to overwrite"
  fi

  mkdir -p "$DATA_DIR"
  # Restore *replaces* the in-scope state rather than merging over it, so the
  # result is exactly what was backed up — a merge could resurrect a rotated
  # SSH key left in secrets/ or a stale config in adguard/conf/. Only the paths
  # the archive owns are cleared; regenerable siblings (ansible/venv,
  # ansible/playbooks, adguard/AdGuardHome, logs/) are out of scope and left
  # intact, so a restore doesn't force an expensive venv rebuild.
  local rel
  for rel in "${IN_SCOPE_DIRS[@]}" "${IN_SCOPE_FILES[@]}"; do
    [ -e "$tmp/data/$rel" ] && rm -rf "${DATA_DIR:?}/$rel"
  done
  # Drop any stale WAL/SHM sidecars next to the old policy.sqlite: the snapshot
  # is a self-contained DB, and replaying a previous deployment's WAL onto it
  # would corrupt the restore.
  if [ -e "$tmp/data/policy.sqlite" ]; then
    rm -f "${DATA_DIR:?}/policy.sqlite-wal" "${DATA_DIR:?}/policy.sqlite-shm"
  fi
  # Copy the payload's *contents* into the data dir, preserving perms/ownership
  # bits (matters for secrets/). The trailing /. copies dotfiles too.
  cp -a "$tmp/data/." "$DATA_DIR/"
  log "Restored backup '$archive' into '$DATA_DIR'."

  if [ -f "$DATA_DIR/policy.sqlite" ]; then
    require_cmd sqlite3
    local integrity
    integrity="$(sqlite3 "$DATA_DIR/policy.sqlite" 'PRAGMA integrity_check;' 2>/dev/null || true)"
    [ "$integrity" = "ok" ] || die "restored policy.sqlite failed integrity_check (got: ${integrity:-<empty>})"
    log "Restored policy.sqlite passed integrity_check."
  fi
}

# --- dispatch --------------------------------------------------------------

main() {
  [ $# -ge 1 ] || {
    usage >&2
    exit 2
  }
  local sub="$1"
  shift
  case "$sub" in
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    -h | --help | help) usage ;;
    *)
      err "unknown subcommand '$sub'"
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
