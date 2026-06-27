#!/usr/bin/env bats
#
# Unit tests for client/install-baseline-tools.sh, exercised through its CLI
# under PCT_DRY_RUN=1 so no root, network, or upstream tools are required.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../install-baseline-tools.sh"
  # Self-managed temp dir: the apt `bats` on ubuntu-22.04 (1.2.x) predates
  # BATS_TEST_TMPDIR, so create our own and clean it up in teardown.
  TMP="$(mktemp -d)"
  # Force the supported-distro check to pass regardless of the host the tests
  # run on, and keep downloads/installs out of real system paths.
  OSREL="${TMP}/os-release"
  printf 'ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=jammy\n' >"$OSREL"
  export PCT_OS_RELEASE="$OSREL"
  export PCT_DRY_RUN=1
  export AW_PREFIX="${TMP}/opt-aw"
  export E2G_DIR="${TMP}/etc-e2g"
  export E2G_PCT_DIR="${E2G_DIR}/pct.d"
  # A glob that matches nothing, so the "add PPA" branch runs by default.
  export TIMEKPR_PPA_LIST_GLOB="${TMP}/no-such-*.list"
}

teardown() {
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
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
  [[ "$output" == *"Adding Timekpr-nExT PPA ppa:mjasnik/ppa"* ]]
  # We add the PPA ourselves (not via add-apt-repository) so the launchpad/key
  # fetches use a timeout we control.
  [[ "$output" != *"add-apt-repository"* ]]
  [[ "$output" == *"write /etc/apt/sources.list.d/timekpr-next-ppa.sources"* ]]
  [[ "$output" == *"apt-get install"*"timekpr-next"* ]]
  [[ "$output" == *"e2guardian"* ]]
}

@test "the PPA fetch timeout is configurable (PCT_PPA_FETCH_TIMEOUT)" {
  PCT_PPA_FETCH_TIMEOUT=120 plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"fetch timeout 120s"* ]]
  [[ "$output" == *"curl --max-time 120"* ]]
}

@test "resolves the PPA suite from UBUNTU_CODENAME (Mint reports its Ubuntu base)" {
  # Mint carries its own VERSION_CODENAME (e.g. virginia) but the PPA is built
  # for the Ubuntu base in UBUNTU_CODENAME — that must win.
  printf 'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=virginia\nUBUNTU_CODENAME=jammy\n' >"$OSREL"
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"timekpr-next-ppa.sources (deb https://ppa.launchpadcontent.net/mjasnik/ppa/ubuntu jammy main)"* ]]
}

@test "pins the AW version and checksum-verifies the download" {
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"activitywatch-v0.13.2-linux-x86_64.zip"* ]]
  [[ "$output" == *"sha256sum --check"* ]]
}

@test "aw-server config binds to loopback only (real write)" {
  local home="${TMP}/home"
  # Generate the config for real (dry-run suppresses file content), then
  # assert the written file pins aw-server to 127.0.0.1:5600.
  run env -u PCT_DRY_RUN bash -c '. "$1"; pct_aw_server_config "$2"' _ "$SCRIPT" "$home"
  [ "$status" -eq 0 ]
  local cfg="${home}/.config/activitywatch/aw-server-rust/config.toml"
  [ -f "$cfg" ]
  grep -q 'host = "127.0.0.1"' "$cfg"
  grep -q 'port = 5600' "$cfg"
}

@test "e2guardian baseline filter group is permissive (real write)" {
  # Generate the filter group for real (dry-run suppresses file content) and
  # assert it is allow-all so installing e2guardian never blocks browsing
  # before the admin pushes real rules.
  run env -u PCT_DRY_RUN E2G_DIR="${TMP}/etc-e2g" \
    bash -c '. "$1"; pct_e2g_baseline_filtergroup' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  local conf="${TMP}/etc-e2g/e2guardianf1.conf"
  [ -f "$conf" ]
  grep -q 'naughtynesslimit = 9999' "$conf"
  grep -q 'PERMISSIVE' "$conf"
}

@test "e2guardian is enabled via /etc/default and the f1 filter group" {
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"write /etc/default/e2guardian"* ]]
  [[ "$output" == *"/e2guardianf1.conf"* ]]
}

@test "supervised user's written files are chowned back to the user" {
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"chown -R alice: "*"/.config"* ]]
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

@test "tunes Timekpr-nExT warning lead times generously for Alpha-1" {
  plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"set TIMEKPR_FINAL_NOTIFICATION_TIME = 300"* ]]
  [[ "$output" == *"set TIMEKPR_FINAL_WARNING_TIME = 60"* ]]
}

@test "enables the timekpr client indicator autostart for each supervised user" {
  plan --supervised-user alice --supervised-user bob
  [ "$status" -eq 0 ]
  [[ "$output" == *"enable timekpr client indicator autostart for alice"* ]]
  [[ "$output" == *"enable timekpr client indicator autostart for bob"* ]]
  [[ "$output" == *"timekpr-client.desktop"* ]]
}

@test "client autostart copies the package entry and force-enables it (real write)" {
  # A package autostart entry that is DISABLED by a stale Hidden=true; the copy
  # must keep its Exec but flip it back on.
  local src="${TMP}/timekpr-client.desktop"
  cat >"$src" <<'EOF'
[Desktop Entry]
Type=Application
Name=Timekpr-nExT Client
Exec=timekprc --indicator
Hidden=true
X-GNOME-Autostart-enabled=false
EOF
  local dest="${TMP}/home/.config/autostart/timekpr-client.desktop"
  run env -u PCT_DRY_RUN bash -c \
    '. "$1"; pct_timekpr_write_user_autostart "$2" "$3"' _ "$SCRIPT" "$src" "$dest"
  [ "$status" -eq 0 ]
  [ -f "$dest" ]
  # Exec is preserved from the package entry...
  grep -qxF 'Exec=timekprc --indicator' "$dest"
  # ...and the entry is forced enabled (no leftover disabling lines).
  grep -qxF 'Hidden=false' "$dest"
  grep -qxF 'X-GNOME-Autostart-enabled=true' "$dest"
  ! grep -qiE '^[[:space:]]*Hidden[[:space:]]*=[[:space:]]*true' "$dest"
  ! grep -qiE '^[[:space:]]*X-GNOME-Autostart-enabled[[:space:]]*=[[:space:]]*false' "$dest"
}

@test "does no iptables work (deferred to Phase 6 Ansible)" {
  plan --supervised-user alice
  # No iptables command should appear anywhere in the executed plan.
  run bash -c 'echo "$1" | grep -i "iptables"' _ "$output"
  [ "$status" -ne 0 ]
}

@test "PPA add is skipped when a legacy add-apt-repository list already exists (idempotent)" {
  local listfile="${TMP}/existing-mjasnik.list"
  : >"$listfile"
  TIMEKPR_PPA_LIST_GLOB="${TMP}/existing-*.list" \
    run env bash "$SCRIPT" --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"Timekpr-nExT PPA already present"* ]]
  [[ "$output" != *"timekpr-next-ppa.sources"* ]]
}

@test "PPA add is skipped when our sources file already exists (idempotent re-run)" {
  local sources="${TMP}/timekpr-next-ppa.sources"
  : >"$sources"
  TIMEKPR_PPA_SOURCES="$sources" plan --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"Timekpr-nExT PPA already present"* ]]
  [[ "$output" != *"Adding Timekpr-nExT PPA"* ]]
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
