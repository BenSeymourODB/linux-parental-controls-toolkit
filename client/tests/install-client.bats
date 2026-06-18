#!/usr/bin/env bats
#
# Unit tests for client/install-client.sh (the Phase-3 orchestrator, #76),
# exercised through its CLI under PCT_DRY_RUN=1 so no root, network, or upstream
# tools are required. A dry run prints the intended plan and has no side effects;
# the tests assert on that plan and on the parsed enrol response.
#
# The orchestrator sources provision-agent-user.sh and install-baseline-tools.sh;
# those have their own bats suites for the real (side-effecting) behaviour. Here
# we verify the orchestration: arg parsing, pre-flight, sequencing, the enrol
# request/response handling, and graceful degradation.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../install-client.sh"
  TMP="$(mktemp -d)"

  # Force the supported-distro check to pass regardless of the CI host.
  OSREL="${TMP}/os-release"
  printf 'ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=jammy\n' >"$OSREL"
  export PCT_OS_RELEASE="$OSREL"

  export PCT_DRY_RUN=1
  # Keep the baseline sub-step's downloads/writes out of real system paths.
  export AW_PREFIX="${TMP}/opt-aw"
  export E2G_DIR="${TMP}/etc-e2g"
  export E2G_PCT_DIR="${E2G_DIR}/pct.d"
  export TIMEKPR_PPA_LIST_GLOB="${TMP}/no-such-*.list"
  # Credential hand-off file goes under the tmpdir, not /etc.
  export PCT_STATE_DIR="${TMP}/etc-pct"
}

teardown() {
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
}

# Run the orchestrator in dry-run with the given args.
plan() {
  run env bash "$SCRIPT" "$@"
}

# A fully-specified, valid invocation used by most happy-path tests.
ok_args() {
  plan --server-url https://parentalcontrols.lan \
    --enrolment-token TESTTOKEN123 \
    --supervised-user alice "$@"
}

# --- argument / usage handling ---------------------------------------------

@test "--help prints usage and exits 0" {
  plan --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: install-client.sh"* ]]
}

@test "requires --server-url" {
  plan --enrolment-token T --supervised-user alice
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing --server-url"* ]]
}

@test "requires --enrolment-token" {
  plan --server-url https://dash.lan --supervised-user alice
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing --enrolment-token"* ]]
}

@test "requires at least one supervised user" {
  plan --server-url https://dash.lan --enrolment-token T
  [ "$status" -ne 0 ]
  [[ "$output" == *"no supervised users given"* ]]
}

@test "rejects an unknown argument" {
  plan --bogus
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown argument: --bogus"* ]]
}

@test "accepts the --flag=value form" {
  plan --server-url=https://dash.lan \
    --enrolment-token=T \
    --supervised-user=alice
  [ "$status" -eq 0 ]
}

@test "accepts the American --enrollment-token spelling" {
  plan --server-url https://dash.lan \
    --enrollment-token T \
    --supervised-user alice
  [ "$status" -eq 0 ]
}

@test "reads configuration from the environment" {
  PCT_SERVER_URL=https://dash.lan \
    PCT_ENROLMENT_TOKEN=ENVTOKEN \
    PCT_SUPERVISED_USERS="carol dave" \
    run env bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"supervising: carol dave"* ]]
}

# --- pre-flight ------------------------------------------------------------

@test "rejects an unsupported (non-Debian-family) distro" {
  printf 'ID=fedora\nID_LIKE=rhel\n' >"$OSREL"
  ok_args
  [ "$status" -ne 0 ]
  [[ "$output" == *"unsupported distro"* ]]
}

@test "plans a reachability probe of the dashboard" {
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"--max-time 10 https://parentalcontrols.lan"* ]]
}

# --- sequencing ------------------------------------------------------------

@test "sequences provision, baseline install, enrol, and self-test" {
  ok_args
  [ "$status" -eq 0 ]
  # The four ordered sub-steps each announce themselves.
  [[ "$output" == *"Provision the pct-agent service account"* ]]
  [[ "$output" == *"Install + baseline-configure the upstream tools"* ]]
  [[ "$output" == *"Register this client with the dashboard"* ]]
  [[ "$output" == *"Run the post-install self-test"* ]]
  [[ "$output" == *"client enrolment complete for: alice"* ]]
}

@test "invokes the baseline tool installer (delegation, not reimplementation)" {
  ok_args
  [ "$status" -eq 0 ]
  # A line only install-baseline-tools.sh emits — proves we delegate to it.
  [[ "$output" == *"add-apt-repository -y ppa:mjasnik/ppa"* ]]
  [[ "$output" == *"ActivityWatch units for alice"* ]]
}

@test "configures every supervised user via the baseline step" {
  ok_args --supervised-user bob
  [ "$status" -eq 0 ]
  [[ "$output" == *"supervising: alice bob"* ]]
  [[ "$output" == *"ActivityWatch units for alice"* ]]
  [[ "$output" == *"ActivityWatch units for bob"* ]]
}

# --- enrolment request -----------------------------------------------------

@test "POSTs to the dashboard enrol endpoint" {
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"POST https://parentalcontrols.lan/api/clients/enrol"* ]]
}

@test "never prints the enrolment token (redacted in the plan)" {
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"Authorization: Bearer <redacted>"* ]]
  [[ "$output" != *"TESTTOKEN123"* ]]
}

@test "builds an enrol body with the supervised user mapping" {
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *'"sshUser": "pct-agent"'* ]]
  [[ "$output" == *'"linuxUsername": "alice"'* ]]
  [[ "$output" == *'"linuxUid":'* ]]
}

@test "--ssh-user overrides the SSH principal in the enrol body" {
  ok_args --ssh-user customagent
  [ "$status" -eq 0 ]
  [[ "$output" == *'"sshUser": "customagent"'* ]]
}

# --- enrol response handling ----------------------------------------------

@test "authorizes the dashboard SSH key when the response carries one" {
  export PCT_FAKE_ENROL_RESPONSE='{"clientId":7,"hostname":"h","sshUser":"pct-agent","bearerToken":"BEARER-XYZ","sshPublicKey":"ssh-ed25519 AAAAKEY dashboard@pct","supervisedUsers":[]}'
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"enrolled as client #7"* ]]
  [[ "$output" == *"authorize dashboard ssh key for pct-agent: ssh-ed25519 AAAAKEY dashboard@pct"* ]]
}

@test "degrades gracefully when the dashboard has no SSH key yet" {
  # Default dry-run response has sshPublicKey: null.
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"returned no SSH public key yet"* ]]
  [[ "$output" == *"authorize it for pct-agent later"* ]]
}

@test "persists the per-client bearer token credential" {
  export PCT_FAKE_ENROL_RESPONSE='{"clientId":7,"hostname":"h","sshUser":"pct-agent","bearerToken":"BEARER-XYZ","sshPublicKey":null,"supervisedUsers":[]}'
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"write ${PCT_STATE_DIR}/pct-client.env"* ]]
  [[ "$output" == *"chmod 0600 ${PCT_STATE_DIR}/pct-client.env"* ]]
  [[ "$output" == *"client credentials stored at ${PCT_STATE_DIR}/pct-client.env"* ]]
}

# --- self-test hook --------------------------------------------------------

@test "notes the self-test is pending when it is not installed" {
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"self-test not installed yet (tracked as #80)"* ]]
}

@test "invokes the self-test when one is installed" {
  local selftest="${TMP}/self-test.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$selftest"
  chmod +x "$selftest"
  PCT_SELF_TEST="$selftest" ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"${selftest}"* ]]
}

# --- dry-run guarantee -----------------------------------------------------

@test "a dry run reports that nothing was changed" {
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *"(dry-run: nothing was changed)"* ]]
}

@test "a dry run writes nothing under the state dir" {
  ok_args
  [ "$status" -eq 0 ]
  [ ! -e "${PCT_STATE_DIR}/pct-client.env" ]
}
