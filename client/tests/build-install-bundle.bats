#!/usr/bin/env bats
#
# Tests for client/build-install-bundle.sh — the bundler that produces the
# SELF-CONTAINED install-client.sh the dashboard serves at GET /install-client.sh.
#
# The regression these guard against (the screenshot bug): the modular
# orchestrator sources its sub-steps from sibling files, so when it is downloaded
# and piped to a shell on a fresh machine —
#
#   curl -fsSL https://<server>/install-client.sh | sudo bash -s -- …
#
# — there are no siblings and `${BASH_SOURCE[0]}` is unbound under `set -u`, so it
# died with "BASH_SOURCE[0]: unbound variable" / "lib/…: No such file". The bundle
# must run cleanly with NO sibling files present and when read from stdin.

setup() {
  BUILDER="${BATS_TEST_DIRNAME}/../build-install-bundle.sh"
  TMP="$(mktemp -d)"

  # Build the bundle, then ISOLATE it: copy only the single bundled file into an
  # otherwise-empty dir, reproducing a freshly-curled machine with no lib/ tree.
  BUNDLE_SRC="${TMP}/bundle.sh"
  bash "$BUILDER" "$BUNDLE_SRC"
  ISO="${TMP}/iso"
  mkdir -p "$ISO"
  cp "$BUNDLE_SRC" "${ISO}/install-client.sh"

  # Force the supported-distro check to pass regardless of the CI host, and keep
  # all side effects in the tmpdir (mirrors install-client.bats).
  OSREL="${TMP}/os-release"
  printf 'ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=jammy\n' >"$OSREL"
  export PCT_OS_RELEASE="$OSREL"
  export PCT_DRY_RUN=1
  export AW_PREFIX="${TMP}/opt-aw"
  export E2G_DIR="${TMP}/etc-e2g"
  export E2G_PCT_DIR="${E2G_DIR}/pct.d"
  export TIMEKPR_PPA_LIST_GLOB="${TMP}/no-such-*.list"
  export PCT_STATE_DIR="${TMP}/etc-pct"
}

teardown() {
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
}

@test "the bundle is valid bash and self-contained (no source/.-of-a-sibling)" {
  run bash -n "${ISO}/install-client.sh"
  [ "$status" -eq 0 ]
  # It must not try to source a path relative to its own (absent) directory.
  run grep -nE '^\s*(\.|source)\s' "${ISO}/install-client.sh"
  [ "$status" -ne 0 ]
}

@test "runs from an isolated dir with no sibling files (file invocation)" {
  run env bash "${ISO}/install-client.sh" \
    --server-url https://parentalcontrols.lan \
    --enrolment-token TESTTOKEN123 \
    --supervised-user evie
  [ "$status" -eq 0 ]
  [[ "$output" == *"client enrolment complete for: evie"* ]]
  # The original failure signatures must be gone.
  [[ "$output" != *"BASH_SOURCE"* ]]
  [[ "$output" != *"No such file or directory"* ]]
}

@test "runs when piped via stdin, reproducing the curl|bash bootstrap" {
  # `bash -s -- …` reads the script from stdin exactly like `curl … | bash -s --`,
  # the invocation in the bug report.
  run bash -c 'cat "$1" | bash -s -- \
      --server-url http://192.168.5.95:8000 \
      --enrolment-token TOK \
      --supervised-user evie' _ "${ISO}/install-client.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"client enrolment complete for: evie"* ]]
  [[ "$output" != *"unbound variable"* ]]
}

@test "still sequences every sub-step (delegation preserved through the bundle)" {
  run env bash "${ISO}/install-client.sh" \
    --server-url https://dash.lan --enrolment-token T --supervised-user evie
  [ "$status" -eq 0 ]
  [[ "$output" == *"Provision the pct-agent service account"* ]]
  # A line only install-baseline-tools.sh emits — proves the embedded module ran.
  [[ "$output" == *"add-apt-repository -y ppa:mjasnik/ppa"* ]]
  [[ "$output" == *"POST https://dash.lan/api/clients/enrol"* ]]
  # The bundled self-test (executable in the bundle) is found, not skipped.
  [[ "$output" == *"self-test.sh evie"* ]]
}

@test "rejects an unsupported distro through the bundled dispatch" {
  printf 'ID=fedora\nID_LIKE=rhel\n' >"$OSREL"
  run env bash "${ISO}/install-client.sh" \
    --server-url https://dash.lan --enrolment-token T --supervised-user evie
  [ "$status" -ne 0 ]
  [[ "$output" == *"unsupported distro"* ]]
}

@test "is deterministic (same inputs -> byte-identical bundle)" {
  bash "$BUILDER" "${TMP}/a.sh"
  bash "$BUILDER" "${TMP}/b.sh"
  run cmp -s "${TMP}/a.sh" "${TMP}/b.sh"
  [ "$status" -eq 0 ]
}
