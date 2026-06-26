#!/usr/bin/env bash
#
# debian.sh — Debian-family (Debian / Ubuntu / Linux Mint) distro adapter (#231).
#
# The first client/distros/<id>.sh adapter. It encapsulates the apt-based path
# the Phase-3 baseline targets first (docs/client-install.md → "Other
# distributions"). Adding another distro (Fedora / openSUSE / Arch) is a new
# sibling file here, selected by client/lib/pct-dispatch.sh — never a change to
# the dispatch itself.
#
# Sourced (not executed) by pct-dispatch.sh after the OS family is confirmed to
# be Linux and this adapter is matched. It relies on the shared helpers
# (pct_err, pct_require_debian_family) that pct-dispatch.sh has already sourced
# from pct-common.sh.

# The family this adapter serves. Read by pct-dispatch.sh after sourcing (and so
# not "unused" despite shellcheck's per-file view).
# shellcheck disable=SC2034
PCT_DISTRO_FAMILY="debian"

# Confirm the detected distro is one this adapter supports. Called by the
# dispatch after sourcing. Delegates to the shared Debian-family predicate so
# the membership rule lives in exactly one place; this hook is the per-adapter
# contract every distro adapter implements.
pct_distro_assert_supported() {
  pct_require_debian_family
}
