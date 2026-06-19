#!/usr/bin/env bats
#
# Unit tests for client/lib/pct-common.sh — the shared helper library.

setup() {
  LIB="${BATS_TEST_DIRNAME}/../lib/pct-common.sh"
  # Self-managed temp dir: the apt `bats` on ubuntu-22.04 (1.2.x) predates
  # BATS_TEST_TMPDIR, so create our own and clean it up in teardown.
  TMP="$(mktemp -d)"
  # The library is safe to source (it sets no shell options); start each test
  # from a clean dry-run state.
  unset PCT_DRY_RUN PCT_COMMON_SOURCED
  # shellcheck source=client/lib/pct-common.sh
  . "$LIB"
}

teardown() {
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
}

@test "logging helpers write to stderr with a pct: prefix" {
  run pct_log "hello world"
  [ "$status" -eq 0 ]
  [[ "$output" == "pct: hello world" ]]

  run pct_warn "careful"
  [[ "$output" == "pct: [warn] careful" ]]

  run pct_err "broke"
  [[ "$output" == "pct: [error] broke" ]]
}

@test "pct_is_dry_run is false when unset and true when set" {
  unset PCT_DRY_RUN
  run pct_is_dry_run
  [ "$status" -ne 0 ]

  PCT_DRY_RUN=0 run pct_is_dry_run
  [ "$status" -ne 0 ]

  PCT_DRY_RUN=1 run pct_is_dry_run
  [ "$status" -eq 0 ]

  PCT_DRY_RUN=yes run pct_is_dry_run
  [ "$status" -eq 0 ]
}

@test "pct_run prints (but does not execute) the command under dry-run" {
  local marker="${TMP}/should-not-exist"
  PCT_DRY_RUN=1 run pct_run touch "$marker"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[dry-run] touch ${marker}"* ]]
  [ ! -e "$marker" ]
}

@test "pct_run executes the command when not in dry-run" {
  local marker="${TMP}/created"
  unset PCT_DRY_RUN
  pct_run touch "$marker"
  [ -f "$marker" ]

  run pct_run echo "ran"
  [ "$status" -eq 0 ]
  [[ "$output" == "ran" ]]
}

@test "pct_detect_distro parses ID and ID_LIKE from a fixture os-release" {
  local f="${TMP}/os-release"
  cat >"$f" <<'EOF'
NAME="Linux Mint"
ID=linuxmint
ID_LIKE="ubuntu debian"
VERSION_CODENAME=virginia
EOF
  PCT_OS_RELEASE="$f" pct_detect_distro
  [ "$PCT_OS_ID" = "linuxmint" ]
  [ "$PCT_OS_ID_LIKE" = "ubuntu debian" ]
}

@test "pct_require_debian_family accepts mint/ubuntu/debian and rejects fedora" {
  local f="${TMP}/os-release"

  printf 'ID=ubuntu\n' >"$f"
  PCT_OS_RELEASE="$f" run pct_require_debian_family
  [ "$status" -eq 0 ]

  printf 'ID=linuxmint\nID_LIKE="ubuntu debian"\n' >"$f"
  PCT_OS_RELEASE="$f" run pct_require_debian_family
  [ "$status" -eq 0 ]

  printf 'ID=fedora\nID_LIKE="rhel"\n' >"$f"
  PCT_OS_RELEASE="$f" run pct_require_debian_family
  [ "$status" -ne 0 ]
  [[ "$output" == *"unsupported distro"* ]]
}

@test "pct_write_file reports intent (and writes nothing) under dry-run" {
  local target="${TMP}/sub/dir/file.conf"
  PCT_DRY_RUN=1 run bash -c '. "$1"; printf "data\n" | pct_write_file "$2"' _ "$LIB" "$target"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[dry-run] write ${target}"* ]]
  [ ! -e "$target" ]
}

@test "pct_write_file writes content and creates parent dirs when not dry-run" {
  local target="${TMP}/sub/dir/file.conf"
  unset PCT_DRY_RUN
  printf 'line one\nline two\n' | pct_write_file "$target"
  [ -f "$target" ]
  [ "$(cat "$target")" = "$(printf 'line one\nline two')" ]
}
