#!/usr/bin/env bash
#
# pct-dispatch.sh — OS-family-first client install dispatch (#231).
#
# The client install entry points branch on **OS family first** (Linux today;
# macOS / Windows are future, *non-distro* families that would ship as their own
# installer BESIDE client/distros/, not inside it — see
# docs/windows-client-support.md → "Modularity tweaks to make cheaply now",
# item 5). Only *within* the Linux family do we select a per-distro adapter from
# client/distros/<id>.sh (docs/client-install.md → "Other distributions").
#
# This file holds no distro- or family-specific package logic; each distro's
# specifics live in its own client/distros/<id>.sh adapter, so adding a distro
# (or, later, a non-Linux family) is additive rather than a refactor.
#
# Pure orchestration. No GPL code is vendored or linked here.
#
# Idempotent and safe to source more than once.

# Guard against double-sourcing (the orchestrator and the baseline step both
# source this). This file is only ever sourced, so `return` is valid here.
if [ -n "${PCT_DISPATCH_SOURCED:-}" ]; then
  return 0
fi
PCT_DISPATCH_SOURCED=1

# Resolve our own directory so the distro adapters can be found whether the
# script is run from the repo, copied elsewhere, or piped through `bash`.
PCT_DISPATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The shared helpers (logging, /etc/os-release detection, the debian-family
# predicate the debian adapter delegates to). Guarded against double-sourcing.
# shellcheck source=client/lib/pct-common.sh
. "${PCT_DISPATCH_DIR}/pct-common.sh"

# Where the per-distro adapters live. Defaults to client/distros/ beside this
# lib; overridable via PCT_DISTROS_DIR so tests can point at a fixture tree.
PCT_DISTROS_DIR="${PCT_DISTROS_DIR:-${PCT_DISPATCH_DIR}/../distros}"

# --- OS family detection ---------------------------------------------------

# Detect the OS family, setting and echoing PCT_OS_FAMILY. The `uname -s` value
# is overridable via PCT_UNAME so tests can exercise non-Linux families without
# a non-Linux host. Linux is the only family with an installer today.
pct_detect_os_family() {
  local sys="${PCT_UNAME:-$(uname -s 2>/dev/null || echo unknown)}"
  case "$sys" in
  Linux) PCT_OS_FAMILY="linux" ;;
  Darwin) PCT_OS_FAMILY="macos" ;;
  MINGW* | MSYS* | CYGWIN* | *NT* | Windows*) PCT_OS_FAMILY="windows" ;;
  *) PCT_OS_FAMILY="$(printf '%s' "$sys" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  printf '%s' "$PCT_OS_FAMILY"
}

# --- distro adapter resolution (Linux only) --------------------------------

# Resolve the client/distros adapter for the detected Linux distro, echoing its
# path on stdout. Tries an exact client/distros/<ID>.sh match first, then maps
# the Debian family (by /etc/os-release ID or ID_LIKE) to the debian adapter.
# Returns non-zero (and echoes nothing) when no adapter matches.
pct_resolve_distro_adapter() {
  pct_detect_distro || true
  local exact="${PCT_DISTROS_DIR}/${PCT_OS_ID}.sh"
  if [ -n "${PCT_OS_ID}" ] && [ -f "$exact" ]; then
    printf '%s' "$exact"
    return 0
  fi
  # Family fallback: a distro whose ID isn't a named adapter but which declares
  # Debian-family kinship (e.g. ID=linuxmint ID_LIKE="ubuntu debian") uses the
  # debian adapter.
  case " ${PCT_OS_ID} ${PCT_OS_ID_LIKE} " in
  *" debian "* | *" ubuntu "* | *" linuxmint "*)
    local debian="${PCT_DISTROS_DIR}/debian.sh"
    if [ -f "$debian" ]; then
      printf '%s' "$debian"
      return 0
    fi
    ;;
  esac
  return 1
}

# --- family-first entry point ----------------------------------------------

# Confirm this host is a client family/distro we can install on, sourcing the
# matching distro adapter as a side effect. The family is checked first: a
# non-Linux family fails with a clear "not implemented yet" message rather than
# being mistaken for an unsupported distro, leaving a clean seam for a future
# non-Linux installer. Within Linux, the distro adapter is resolved, sourced,
# and asked to confirm it supports this distro.
pct_require_supported_client() {
  # Only the side effect (PCT_OS_FAMILY) is wanted here; discard the echo.
  pct_detect_os_family >/dev/null
  if [ "${PCT_OS_FAMILY}" != "linux" ]; then
    pct_err "no client installer for OS family '${PCT_OS_FAMILY}' yet; only 'linux' is implemented today (a non-Linux family such as Windows would ship as its own installer beside client/distros/, not inside it — see docs/windows-client-support.md)"
    return 1
  fi
  # Detect the distro in this scope so PCT_OS_ID/PCT_OS_ID_LIKE are set for the
  # error message below; pct_resolve_distro_adapter runs in a $(...) subshell and
  # its detection would not propagate back here.
  pct_detect_distro || true
  local adapter
  if ! adapter="$(pct_resolve_distro_adapter)"; then
    pct_err "unsupported distro (ID='${PCT_OS_ID}' ID_LIKE='${PCT_OS_ID_LIKE}'); no client/distros adapter matches — the Debian/Ubuntu/Mint family is supported today (see docs/client-install.md → \"Other distributions\")"
    return 1
  fi
  # Recorded as a side effect for callers/tests to inspect which adapter was
  # chosen (not consumed within this file, hence the shellcheck note).
  # shellcheck disable=SC2034
  PCT_DISTRO_ADAPTER="$adapter"
  # The adapter path comes from our own client/distros/ tree (or a test fixture
  # via PCT_DISTROS_DIR), not from external input.
  # shellcheck source=/dev/null
  . "$adapter"
  # Quiet on success (matching the predicate it replaces); the adapter's own
  # pct_distro_assert_supported decides whether this distro is supported.
  pct_distro_assert_supported
}
