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

@test "pct_retry returns immediately and silently on a first-try success" {
  unset PCT_DRY_RUN
  run pct_retry true
  [ "$status" -eq 0 ]
  # A first-try success must read exactly like a plain run: no retry chatter.
  [[ "$output" != *"retrying"* ]]
  [[ "$output" != *"attempt"* ]]
}

@test "pct_retry retries a flaky command and succeeds once it passes" {
  unset PCT_DRY_RUN
  # A command that fails its first attempt and succeeds on the second, tracked
  # via a counter file so state survives across the separate invocations.
  local counter="${TMP}/attempts"
  printf '0\n' >"$counter"
  flaky() {
    local n
    n="$(($(cat "$counter") + 1))"
    printf '%s\n' "$n" >"$counter"
    [ "$n" -ge 2 ]
  }
  export -f flaky
  export counter
  PCT_RETRY_DELAY=0 run pct_retry flaky
  [ "$status" -eq 0 ]
  [[ "$output" == *"attempt 1/3 failed"* ]]
  [ "$(cat "$counter")" -eq 2 ]
}

@test "pct_retry gives up after PCT_RETRIES attempts and returns the exit code" {
  unset PCT_DRY_RUN
  PCT_RETRIES=3 PCT_RETRY_DELAY=0 run pct_retry bash -c 'exit 22'
  [ "$status" -eq 22 ]
  [[ "$output" == *"still failing after 3 attempt(s)"* ]]
  [[ "$output" == *"giving up"* ]]
}

@test "pct_retry honours dry-run: prints once, never executes or sleeps" {
  local marker="${TMP}/should-not-exist"
  PCT_DRY_RUN=1 run pct_retry touch "$marker"
  [ "$status" -eq 0 ]
  [[ "$output" == *"[dry-run] touch ${marker}"* ]]
  [[ "$output" != *"retrying"* ]]
  [ ! -e "$marker" ]
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

@test "pct_set_conf_key reports intent (and writes nothing) under dry-run" {
  local target="${TMP}/timekpr.conf"
  PCT_DRY_RUN=1 run pct_set_conf_key "$target" TIMEKPR_FINAL_WARNING_TIME 60
  [ "$status" -eq 0 ]
  [[ "$output" == *"[dry-run] set TIMEKPR_FINAL_WARNING_TIME = 60 in ${target}"* ]]
  [ ! -e "$target" ]
}

@test "pct_set_conf_key replaces an existing key in place, preserving other lines" {
  local target="${TMP}/timekpr.conf"
  cat >"$target" <<'EOF'
[GENERAL]
TIMEKPR_POLLTIME = 3
TIMEKPR_FINAL_WARNING_TIME = 10
TIMEKPR_TERMINATION_TIME = 15
EOF
  unset PCT_DRY_RUN
  pct_set_conf_key "$target" TIMEKPR_FINAL_WARNING_TIME 60
  grep -qxF 'TIMEKPR_FINAL_WARNING_TIME = 60' "$target"
  # The old value is gone and the neighbouring keys are untouched.
  ! grep -qxF 'TIMEKPR_FINAL_WARNING_TIME = 10' "$target"
  grep -qxF 'TIMEKPR_POLLTIME = 3' "$target"
  grep -qxF 'TIMEKPR_TERMINATION_TIME = 15' "$target"
  # Exactly one assignment for the key (no duplicate appended).
  [ "$(grep -cE '^[[:space:]]*TIMEKPR_FINAL_WARNING_TIME[[:space:]]*=' "$target")" -eq 1 ]
}

@test "pct_set_conf_key appends the key when it is absent" {
  local target="${TMP}/timekpr.conf"
  printf '[GENERAL]\nTIMEKPR_POLLTIME = 3\n' >"$target"
  unset PCT_DRY_RUN
  pct_set_conf_key "$target" TIMEKPR_FINAL_NOTIFICATION_TIME 300
  grep -qxF 'TIMEKPR_FINAL_NOTIFICATION_TIME = 300' "$target"
  grep -qxF 'TIMEKPR_POLLTIME = 3' "$target"
}

@test "pct_set_conf_key does not match a commented-out key (appends instead)" {
  local target="${TMP}/timekpr.conf"
  printf '# TIMEKPR_FINAL_WARNING_TIME = doc comment\n' >"$target"
  unset PCT_DRY_RUN
  pct_set_conf_key "$target" TIMEKPR_FINAL_WARNING_TIME 60
  # The comment is preserved and a real assignment is appended.
  grep -qF '# TIMEKPR_FINAL_WARNING_TIME = doc comment' "$target"
  grep -qxF 'TIMEKPR_FINAL_WARNING_TIME = 60' "$target"
}
