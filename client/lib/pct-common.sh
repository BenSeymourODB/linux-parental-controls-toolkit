#!/usr/bin/env bash
#
# pct-common.sh — shared helpers for the client-side install scripts.
#
# Sourced by the Phase 3 install components (and, later, the
# client/install-client.sh orchestrator, #76). Provides:
#   - structured, non-punitive logging to stderr
#   - a dry-run-aware command runner (PCT_DRY_RUN=1 prints the plan instead
#     of executing) so the scripts can be exercised in CI without root,
#     network, or the upstream tools present
#   - /etc/os-release distro detection
#   - a dry-run-aware file writer
#
# Pure orchestration of distro packages and upstream releases. No GPL code is
# vendored here and nothing is linked in-process; the enforcement/telemetry
# tools come from apt / upstream releases on the client (see
# docs/licensing-analysis.md).
#
# Idempotent and safe to source more than once.

# Guard against double-sourcing (the orchestrator may source several
# components that each source this file). This file is only ever sourced, so
# `return` is valid here.
if [ -n "${PCT_COMMON_SOURCED:-}" ]; then
  return 0
fi
PCT_COMMON_SOURCED=1

# Prefix shown in front of every command the dry-run runner would execute, so
# tests (and humans) can read the intended plan.
PCT_DRYRUN_PREFIX="${PCT_DRYRUN_PREFIX:-[dry-run]}"

# --- logging ---------------------------------------------------------------
#
# Everything goes to stderr so a script's real stdout (e.g. a value a caller
# captures) stays clean. The tone is deliberately plain and non-punitive to
# match the household framing in README.md / docs/client-install.md.

pct_log() { printf 'pct: %s\n' "$*" >&2; }
pct_step() { printf '\npct: == %s ==\n' "$*" >&2; }
pct_ok() { printf 'pct: [ok] %s\n' "$*" >&2; }
pct_warn() { printf 'pct: [warn] %s\n' "$*" >&2; }
pct_err() { printf 'pct: [error] %s\n' "$*" >&2; }

# --- dry-run ---------------------------------------------------------------

# True when PCT_DRY_RUN is set to a non-empty, non-"0" value.
pct_is_dry_run() {
  case "${PCT_DRY_RUN:-}" in
  "" | 0 | false | no) return 1 ;;
  *) return 0 ;;
  esac
}

# Run a command, or — under dry-run — print it (prefixed) without executing.
# Use this for simple argv commands. For anything needing a pipe, redirect, or
# shell construct, branch on pct_is_dry_run directly instead.
pct_run() {
  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "$*" >&2
    return 0
  fi
  "$@"
}

# --- distro detection ------------------------------------------------------

# Parse /etc/os-release into PCT_OS_ID / PCT_OS_ID_LIKE. The path is
# overridable via PCT_OS_RELEASE so tests can point at a fixture.
pct_detect_distro() {
  local os_release="${PCT_OS_RELEASE:-/etc/os-release}"
  PCT_OS_ID=""
  PCT_OS_ID_LIKE=""
  if [ ! -r "$os_release" ]; then
    pct_warn "cannot read ${os_release}; distro unknown"
    return 1
  fi
  # Read ID / ID_LIKE without sourcing the file (avoid executing its content).
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
    ID=*) key=ID ;;
    ID_LIKE=*) key=ID_LIKE ;;
    *) continue ;;
    esac
    value="${line#*=}"
    # Strip surrounding quotes if present.
    value="${value%\"}"
    value="${value#\"}"
    case "$key" in
    ID) PCT_OS_ID="$value" ;;
    ID_LIKE) PCT_OS_ID_LIKE="$value" ;;
    esac
  done <"$os_release"
  return 0
}

# Succeed only on a Debian-family distro (the apt-based path this toolkit
# targets first — Linux Mint / Ubuntu / Debian).
pct_require_debian_family() {
  pct_detect_distro || true
  case " ${PCT_OS_ID} ${PCT_OS_ID_LIKE} " in
  *" debian "* | *" ubuntu "* | *" linuxmint "*)
    return 0
    ;;
  esac
  pct_err "unsupported distro (ID='${PCT_OS_ID}' ID_LIKE='${PCT_OS_ID_LIKE}'); this baseline targets the Debian/Ubuntu/Mint family"
  return 1
}

# --- files -----------------------------------------------------------------

# Write content (read from stdin) to a file, creating parent directories.
# Under dry-run it reports intent and consumes stdin without writing.
# Usage: pct_write_file /path/to/file <<'EOF' ... EOF
pct_write_file() {
  local path="$1"
  if pct_is_dry_run; then
    printf '%s write %s\n' "$PCT_DRYRUN_PREFIX" "$path" >&2
    cat >/dev/null
    return 0
  fi
  mkdir -p "$(dirname "$path")"
  cat >"$path"
}
