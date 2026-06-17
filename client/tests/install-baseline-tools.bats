#!/usr/bin/env bats
#
# Unit tests for client/install-baseline-tools.sh, exercised through its CLI
# under PCT_DRY_RUN=1 so no root, network, or upstream tools are required.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../install-baseline-tools.sh"
  # Force the supported-distro check to pass regardless of the host the tests
  # run on, and keep downloads/installs out of real system paths.
  OSREL="${BATS_TEST_TMPDIR}/os-release"
  printf 'ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=jammy\n' >"$OSREL"
  export PCT_OS_RELEASE="$OSREL"
  export PCT_DRY_RUN=1
  export AW_PREFIX="${BATS_TEST_TMPDIR}/opt-aw"
  export E2G_DIR="${BATS_TEST_TMPDIR}/etc-e2g"
  export E2G_PCT_DIR="${E2G_DIR}/pct.d"
  # A glob that matches nothing, so the "add PPA" branch runs by default.
  export TIMEKPR_PPA_LIST_GLOB="${BATS_TEST_TMPDIR}/no-such-*.list"
}

plan() { # run the script in dry-run with the given args, capture the plan
  run env bash "$SCRIPT" "$@"
}

@test "requires at least one supervised user" {
  plan
  [ "$status" -ne 0 ]
  [[ "$output" == *"no supervised users given"* ]]
}

@test "--help prints usage and exits 0" {
  plan --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: install-baseline-tools.sh"* ]]
}

@test "rejects an unsupported (non-Debian-family) distro" {
  printf 'ID=fedora\nID_LIKE=rhel\n' >"$OSREL"
  plan --supervised-user alice
  [ "$status" -ne 0 ]
  [[ "$output" == *"unsupported distro"* ]]
}

@test "adds the Timekpr PPA and installs the three baseline tools" {
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"add-apt-repository -y ppa:mjasnik/ppa"* ]]
  [[ "$output" == *"apt-get install"*"timekpr-next"* ]]
  [[ "$output" == *"e2guardian"* ]]
}

@test "pins the AW version and checksum-verifies the download" {
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"activitywatch-v0.13.2-linux-x86_64.zip"* ]]
  [[ "$output" == *"sha256sum --check"* ]]
}

@test "aw-server config binds to loopback only (real write)" {
  local home="${BATS_TEST_TMPDIR}/home"
  # Generate the config for real (dry-run suppresses file content), then
  # assert the written file pins aw-server to 127.0.0.1:5600.
  run env -u PCT_DRY_RUN bash -c '. "$1"; pct_aw_server_config "$2"' _ "$SCRIPT" "$home"
  [ "$status" -eq 0 ]
  local cfg="${home}/.config/activitywatch/aw-server-rust/config.toml"
  [ -f "$cfg" ]
  grep -q 'host = "127.0.0.1"' "$cfg"
  grep -q 'port = 5600' "$cfg"
}

@test "configures every supervised user for ActivityWatch and e2guardian" {
  plan --supervised-user alice --supervised-user bob
  [ "$status" -eq 0 ]
  [[ "$output" == *"ActivityWatch units for alice"* ]]
  [[ "$output" == *"ActivityWatch units for bob"* ]]
  [[ "$output" == *"/pct.d/alice.filtergroup"* ]]
  [[ "$output" == *"/pct.d/bob.filtergroup"* ]]
  [[ "$output" == *"enable-linger alice"* ]]
  [[ "$output" == *"enable-linger bob"* ]]
}

@test "enables the timekpr and e2guardian services" {
  plan --supervised-user alice
  [[ "$output" == *"systemctl enable --now timekpr.service"* ]]
  [[ "$output" == *"systemctl enable --now e2guardian.service"* ]]
}

@test "does no iptables work (deferred to Phase 6 Ansible)" {
  plan --supervised-user alice
  # No iptables command should appear anywhere in the executed plan.
  run bash -c 'echo "$1" | grep -i "iptables"' _ "$output"
  [ "$status" -ne 0 ]
}

@test "PPA add is skipped when the list file already exists (idempotent)" {
  local listfile="${BATS_TEST_TMPDIR}/existing-mjasnik.list"
  : >"$listfile"
  TIMEKPR_PPA_LIST_GLOB="${BATS_TEST_TMPDIR}/existing-*.list" \
    run env bash "$SCRIPT" --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"Timekpr-nExT PPA already present"* ]]
  [[ "$output" != *"add-apt-repository"* ]]
}

@test "ActivityWatch download is skipped when the pinned version is present" {
  mkdir -p "$AW_PREFIX"
  printf 'v0.13.2\n' >"${AW_PREFIX}/.pct-aw-version"
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"ActivityWatch v0.13.2 already installed"* ]]
  [[ "$output" != *"curl --fail"* ]]
}

@test "accepts supervised users from PCT_SUPERVISED_USERS env" {
  PCT_SUPERVISED_USERS="carol dave" run env bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ActivityWatch units for carol"* ]]
  [[ "$output" == *"ActivityWatch units for dave"* ]]
}
