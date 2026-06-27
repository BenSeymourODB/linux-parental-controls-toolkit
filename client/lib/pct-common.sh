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

# Run a command, retrying on failure with exponential backoff. Wrap the
# network-dependent install steps (PPA add, apt update/install, upstream
# downloads) so a single transient timeout on home internet — e.g. a slow
# launchpad.net the PPA fetch gives up on after 10s — self-heals instead of
# aborting the whole enrolment under `set -e`. The successful return is silent
# so a first-try success reads exactly like a plain pct_run.
#
# Honours dry-run (prints the command once via pct_run; never sleeps or loops,
# so the dry-run plan stays a single clean line per step). Tunable, mainly so
# tests stay fast and slow links can be given more headroom:
#   PCT_RETRIES      total attempts before giving up (default 3)
#   PCT_RETRY_DELAY  seconds before the 2nd attempt, doubling each time (default 2)
#
# Usage: pct_retry add-apt-repository -y ppa:mjasnik/ppa
pct_retry() {
  if pct_is_dry_run; then
    pct_run "$@"
    return 0
  fi
  local attempts="${PCT_RETRIES:-3}" delay="${PCT_RETRY_DELAY:-2}" n=1 rc=0
  while :; do
    # Capture the exit code with `|| rc=$?` rather than testing in an `if`: a
    # failed `if` with no else resets $? to 0, which would mask the real code.
    # The `|| rc=$?` form is also safe under the callers' `set -e`.
    rc=0
    "$@" || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    if [ "$n" -ge "$attempts" ]; then
      pct_err "still failing after ${attempts} attempt(s) (exit ${rc}); giving up: $*"
      return "$rc"
    fi
    pct_warn "attempt ${n}/${attempts} failed (exit ${rc}); retrying in ${delay}s: $*"
    sleep "$delay"
    n=$((n + 1))
    delay=$((delay * 2))
  done
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

# Recursively give a path to a Linux user (and their login group). Dry-run
# aware. Used after writing into a supervised user's home as root, so the
# files end up owned by the user rather than root.
pct_chown_user() {
  local user="$1" path="$2"
  pct_run chown -R "${user}:" "$path"
}

# Set `KEY = VALUE` in a simple `key = value` config file, replacing an existing
# (uncommented) assignment in place or appending it, and leaving every other
# line untouched. Dry-run aware. Used to tune specific keys in an upstream
# tool's own config (e.g. Timekpr-nExT's warning lead times in
# /etc/timekpr/timekpr.conf) without rewriting the whole file — so the package's
# other settings survive. KEY must be a bare token (no regex metacharacters);
# VALUE must not contain a newline. A leading `#` comment is never matched, so a
# documentation comment for the same key is left alone. Assumes at most one
# uncommented assignment of KEY (the upstream config shape); if several exist
# they are all rewritten to the same value rather than collapsed to one.
# Usage: pct_set_conf_key /etc/timekpr/timekpr.conf TIMEKPR_FINAL_WARNING_TIME 60
pct_set_conf_key() {
  local file="$1" key="$2" value="$3"
  if pct_is_dry_run; then
    printf '%s set %s = %s in %s\n' "$PCT_DRYRUN_PREFIX" "$key" "$value" "$file" >&2
    return 0
  fi
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : >"$file"
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
    # Replace the existing assignment in place via a temp file, then copy the
    # result back so the original file keeps its inode/permissions.
    local tmp
    tmp="$(mktemp)"
    sed -E "s|^[[:space:]]*${key}[[:space:]]*=.*|${key} = ${value}|" "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
  else
    printf '%s = %s\n' "$key" "$value" >>"$file"
  fi
}
