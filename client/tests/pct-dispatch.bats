#!/usr/bin/env bats
#
# Unit tests for client/lib/pct-dispatch.sh — the OS-family-first install
# dispatch (#231). Exercised by sourcing the library and driving its functions
# with /etc/os-release fixtures (PCT_OS_RELEASE) and a stubbed `uname`
# (PCT_UNAME), so no non-Linux host or root is required.

setup() {
  LIB="${BATS_TEST_DIRNAME}/../lib/pct-dispatch.sh"
  # Self-managed temp dir: the apt `bats` on ubuntu-22.04 (1.2.x) predates
  # BATS_TEST_TMPDIR, so create our own and clean it up in teardown.
  TMP="$(mktemp -d)"
  # Start each test from a clean, freshly-sourced state.
  unset PCT_DRY_RUN PCT_COMMON_SOURCED PCT_DISPATCH_SOURCED PCT_UNAME
  unset PCT_OS_FAMILY PCT_OS_ID PCT_OS_ID_LIKE PCT_DISTRO_FAMILY PCT_DISTRO_ADAPTER
  # pct-dispatch.sh sources pct-common.sh for us.
  # shellcheck source=client/lib/pct-dispatch.sh
  . "$LIB"
  # A reusable os-release fixture path.
  OSREL="${TMP}/os-release"
}

teardown() {
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
}

# --- OS family detection ---------------------------------------------------

@test "pct_detect_os_family maps uname to a family (linux/windows/macos)" {
  PCT_UNAME=Linux run pct_detect_os_family
  [ "$status" -eq 0 ]
  [ "$output" = "linux" ]

  PCT_UNAME=Darwin run pct_detect_os_family
  [ "$output" = "macos" ]

  PCT_UNAME=MINGW64_NT-10.0 run pct_detect_os_family
  [ "$output" = "windows" ]

  PCT_UNAME=Windows_NT run pct_detect_os_family
  [ "$output" = "windows" ]
}

@test "pct_detect_os_family lowercases an unrecognised uname" {
  PCT_UNAME=FreeBSD run pct_detect_os_family
  [ "$output" = "freebsd" ]
}

# --- distro adapter resolution ---------------------------------------------

@test "pct_resolve_distro_adapter maps the Debian family to debian.sh" {
  printf 'ID=ubuntu\nID_LIKE=debian\n' >"$OSREL"
  PCT_OS_RELEASE="$OSREL" run pct_resolve_distro_adapter
  [ "$status" -eq 0 ]
  [[ "$output" == *"/distros/debian.sh" ]]

  # Linux Mint reaches debian.sh via ID_LIKE (its ID has no named adapter).
  printf 'ID=linuxmint\nID_LIKE="ubuntu debian"\n' >"$OSREL"
  PCT_OS_RELEASE="$OSREL" run pct_resolve_distro_adapter
  [ "$status" -eq 0 ]
  [[ "$output" == *"/distros/debian.sh" ]]

  # Plain Debian matches the debian.sh adapter by its exact ID, too.
  printf 'ID=debian\n' >"$OSREL"
  PCT_OS_RELEASE="$OSREL" run pct_resolve_distro_adapter
  [ "$status" -eq 0 ]
  [[ "$output" == *"/distros/debian.sh" ]]
}

@test "pct_resolve_distro_adapter prefers an exact client/distros/<ID>.sh match" {
  # A synthetic adapter tree proves the exact-ID path independent of the real
  # client/distros/ contents.
  local dir="${TMP}/distros"
  mkdir -p "$dir"
  printf 'PCT_DISTRO_FAMILY=fedora\npct_distro_assert_supported() { return 0; }\n' >"${dir}/fedora.sh"
  printf 'ID=fedora\nID_LIKE=rhel\n' >"$OSREL"
  PCT_DISTROS_DIR="$dir" PCT_OS_RELEASE="$OSREL" run pct_resolve_distro_adapter
  [ "$status" -eq 0 ]
  [ "$output" = "${dir}/fedora.sh" ]
}

@test "pct_resolve_distro_adapter fails for a distro with no adapter" {
  printf 'ID=fedora\nID_LIKE=rhel\n' >"$OSREL"
  PCT_OS_RELEASE="$OSREL" run pct_resolve_distro_adapter
  [ "$status" -ne 0 ]
  [ -z "$output" ]
}

# --- family-first entry point ----------------------------------------------

@test "pct_require_supported_client accepts a Linux Debian-family host" {
  printf 'ID=ubuntu\nID_LIKE=debian\n' >"$OSREL"
  # Called without `run` so the in-process side effects (sourcing the adapter)
  # are observable; capture the exit status explicitly since bats does not run
  # tests under `set -e`.
  PCT_UNAME=Linux PCT_OS_RELEASE="$OSREL" pct_require_supported_client
  local rc=$?
  [ "$rc" -eq 0 ]
  [ "$PCT_OS_FAMILY" = "linux" ]
  [ "$PCT_DISTRO_FAMILY" = "debian" ]
  [[ "$PCT_DISTRO_ADAPTER" == *"/distros/debian.sh" ]]
}

@test "pct_require_supported_client rejects a non-Linux family before any distro check" {
  # No os-release fixture needed: the family check short-circuits first.
  PCT_UNAME=Windows_NT run pct_require_supported_client
  [ "$status" -ne 0 ]
  [[ "$output" == *"OS family 'windows'"* ]]
  [[ "$output" == *"only 'linux' is implemented"* ]]
}

@test "pct_require_supported_client gates every non-Linux family, not just Windows" {
  # macOS (Darwin) is also rejected — proving the family gate is general, not a
  # Windows special case. Linux is the only family with an installer today.
  PCT_UNAME=Darwin run pct_require_supported_client
  [ "$status" -ne 0 ]
  [[ "$output" == *"OS family 'macos'"* ]]
  [[ "$output" == *"only 'linux' is implemented"* ]]
}

@test "pct_require_supported_client rejects an unsupported Linux distro" {
  printf 'ID=fedora\nID_LIKE=rhel\n' >"$OSREL"
  PCT_UNAME=Linux PCT_OS_RELEASE="$OSREL" run pct_require_supported_client
  [ "$status" -ne 0 ]
  [[ "$output" == *"unsupported distro"* ]]
}
