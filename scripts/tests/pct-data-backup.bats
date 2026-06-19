#!/usr/bin/env bats
#
# Tests for scripts/pct-data-backup.sh — the /data backup/restore utility (#120).
#
# These exercise the real script against real sqlite3/tar (no mocking): the
# whole point of the utility is that a SQLite snapshot is consistent and a
# round-trip preserves the non-regenerable state, so the tests assert that
# end to end.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../pct-data-backup.sh"
  WORK="$(mktemp -d "${BATS_TMPDIR}/pct-bk.XXXXXX")"
  DATA="$WORK/data"
  seed_data_dir "$DATA"
}

teardown() {
  rm -rf "$WORK"
}

# Build a realistic /data layout: in-scope state + regenerable junk.
seed_data_dir() {
  local d="$1"
  mkdir -p "$d/secrets/ssh" "$d/adguard/conf" "$d/ansible/venv/bin" \
    "$d/ansible/playbooks" "$d/logs"
  sqlite3 "$d/policy.sqlite" \
    "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); \
     INSERT INTO t(v) VALUES('alice'),('bob');" >/dev/null
  printf 'PRIVATE-KEY\n' >"$d/secrets/ssh/id_ed25519"
  chmod 600 "$d/secrets/ssh/id_ed25519"
  chmod 700 "$d/secrets/ssh"
  printf 'API=secret\n' >"$d/secrets/api-keys.env"
  chmod 600 "$d/secrets/api-keys.env"
  printf 'filter: yes\n' >"$d/adguard/conf/AdGuardHome.yaml"
  printf 'all: hosts\n' >"$d/ansible/inventory.yml"
  # Regenerable — must be excluded from the backup.
  printf 'BINARY\n' >"$d/adguard/AdGuardHome"
  printf 'venvbin\n' >"$d/ansible/venv/bin/ansible"
  printf 'playbook\n' >"$d/ansible/playbooks/site.yml"
  printf 'logline\n' >"$d/logs/app.log"
}

@test "help text lists both subcommands and exits 0" {
  run "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"backup"* ]]
  [[ "$output" == *"restore"* ]]
}

@test "no subcommand prints usage and exits 2" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
}

@test "unknown subcommand exits 2" {
  run "$SCRIPT" frobnicate
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown subcommand"* ]]
}

@test "backup writes an owner-only archive with MANIFEST + data payload" {
  run "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  [ "$status" -eq 0 ]
  [ -f "$WORK/b.tar.gz" ]
  [ "$(stat -c '%a' "$WORK/b.tar.gz")" = "600" ]
  run tar -tzf "$WORK/b.tar.gz"
  [[ "$output" == *"./MANIFEST"* ]]
  [[ "$output" == *"./data/policy.sqlite"* ]]
}

@test "backup records a passing integrity check in the MANIFEST" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  run tar -xzOf "$WORK/b.tar.gz" ./MANIFEST
  [[ "$output" == *"format_version: 1"* ]]
  [[ "$output" == *"sqlite_integrity_check: ok"* ]]
}

@test "backup excludes the regenerable paths" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  run tar -tzf "$WORK/b.tar.gz"
  # The AdGuard *binary* (data/adguard/AdGuardHome) is excluded; the conf/ tree
  # (data/adguard/conf/AdGuardHome.yaml) is kept — distinct paths, no overlap.
  [[ "$output" != *"data/adguard/AdGuardHome"* ]]
  [[ "$output" == *"data/adguard/conf/"* ]]
  [[ "$output" != *"ansible/venv"* ]]
  [[ "$output" != *"ansible/playbooks"* ]]
  [[ "$output" != *"logs/"* ]]
}

@test "round-trip preserves WAL-mode policy.sqlite rows" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  "$SCRIPT" restore --data-dir "$WORK/restored" "$WORK/b.tar.gz" --quiet
  run sqlite3 "$WORK/restored/policy.sqlite" "SELECT v FROM t ORDER BY id;"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "alice" ]
  [ "${lines[1]}" = "bob" ]
}

@test "round-trip preserves secret file and directory permissions" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  "$SCRIPT" restore --data-dir "$WORK/restored" "$WORK/b.tar.gz" --quiet
  [ "$(stat -c '%a' "$WORK/restored/secrets/ssh/id_ed25519")" = "600" ]
  [ "$(stat -c '%a' "$WORK/restored/secrets/ssh")" = "700" ]
  [ -f "$WORK/restored/secrets/api-keys.env" ]
  [ -f "$WORK/restored/adguard/conf/AdGuardHome.yaml" ]
  [ -f "$WORK/restored/ansible/inventory.yml" ]
}

@test "restore does not recreate excluded/regenerable paths" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  "$SCRIPT" restore --data-dir "$WORK/restored" "$WORK/b.tar.gz" --quiet
  [ ! -e "$WORK/restored/adguard/AdGuardHome" ]
  [ ! -e "$WORK/restored/ansible/venv" ]
  [ ! -e "$WORK/restored/ansible/playbooks" ]
  [ ! -e "$WORK/restored/logs" ]
}

@test "backup of a fresh deploy (no policy.sqlite) still produces an archive" {
  rm -f "$DATA/policy.sqlite"
  run "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  [ "$status" -eq 0 ]
  run tar -xzOf "$WORK/b.tar.gz" ./MANIFEST
  [[ "$output" == *"skipped (no policy.sqlite)"* ]]
  # secrets are still captured even without a DB
  run tar -tzf "$WORK/b.tar.gz"
  [[ "$output" == *"data/secrets/api-keys.env"* ]]
}

@test "restore refuses a non-empty data dir without --force" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  mkdir -p "$WORK/target"
  printf 'existing\n' >"$WORK/target/keep.txt"
  run "$SCRIPT" restore --data-dir "$WORK/target" "$WORK/b.tar.gz" --quiet
  [ "$status" -ne 0 ]
  [[ "$output" == *"--force"* ]]
  [ -f "$WORK/target/keep.txt" ] # original untouched
}

@test "restore --force overwrites a non-empty data dir" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  mkdir -p "$WORK/target"
  printf 'existing\n' >"$WORK/target/keep.txt"
  run "$SCRIPT" restore --data-dir "$WORK/target" --force "$WORK/b.tar.gz" --quiet
  [ "$status" -eq 0 ]
  [ -f "$WORK/target/policy.sqlite" ]
}

@test "restore --force replaces in-scope state (no stale secret / WAL survives)" {
  "$SCRIPT" backup --data-dir "$DATA" --output "$WORK/b.tar.gz" --quiet
  # A target that already holds a *different* deployment's in-scope state.
  mkdir -p "$WORK/target/secrets/ssh" "$WORK/target/ansible/venv"
  printf 'STALE\n' >"$WORK/target/secrets/ssh/old.key"
  printf 'stale-db\n' >"$WORK/target/policy.sqlite"
  printf 'stale-wal\n' >"$WORK/target/policy.sqlite-wal"
  printf 'keepvenv\n' >"$WORK/target/ansible/venv/marker"
  run "$SCRIPT" restore --data-dir "$WORK/target" --force "$WORK/b.tar.gz" --quiet
  [ "$status" -eq 0 ]
  # The archive's secrets fully replace the target's: stale key gone, real one in.
  [ ! -e "$WORK/target/secrets/ssh/old.key" ]
  [ -f "$WORK/target/secrets/ssh/id_ed25519" ]
  # Stale WAL/SHM sidecars are cleared so they can't corrupt the restored DB.
  [ ! -e "$WORK/target/policy.sqlite-wal" ]
  run sqlite3 "$WORK/target/policy.sqlite" "SELECT count(*) FROM t;"
  [ "$output" = "2" ]
  # Out-of-scope regenerable state the archive doesn't own is left untouched.
  [ -f "$WORK/target/ansible/venv/marker" ]
}

@test "restore of a missing archive fails cleanly" {
  run "$SCRIPT" restore --data-dir "$WORK/restored" "$WORK/nope.tar.gz"
  [ "$status" -ne 0 ]
  [[ "$output" == *"does not exist"* ]]
}

@test "restore rejects a tarball that is not a pct-data-backup archive" {
  printf 'junk\n' >"$WORK/x.txt"
  tar -czf "$WORK/notours.tar.gz" -C "$WORK" x.txt
  run "$SCRIPT" restore --data-dir "$WORK/restored" "$WORK/notours.tar.gz"
  [ "$status" -ne 0 ]
  [[ "$output" == *"MANIFEST"* ]]
}

@test "restore rejects an unsupported archive format_version" {
  mkdir -p "$WORK/fake/data"
  printf 'format_version: 99\n' >"$WORK/fake/MANIFEST"
  printf 'x\n' >"$WORK/fake/data/marker"
  tar -czf "$WORK/future.tar.gz" -C "$WORK/fake" .
  run "$SCRIPT" restore --data-dir "$WORK/restored" "$WORK/future.tar.gz"
  [ "$status" -ne 0 ]
  [[ "$output" == *"format_version"* ]]
}

@test "backup fails when the data dir does not exist" {
  run "$SCRIPT" backup --data-dir "$WORK/absent" --output "$WORK/b.tar.gz"
  [ "$status" -ne 0 ]
  [[ "$output" == *"does not exist"* ]]
}
