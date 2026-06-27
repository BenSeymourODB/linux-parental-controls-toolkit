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

# Run with dry-run DISABLED, to exercise the strict (real-run) validation that a
# dry-run preview deliberately relaxes. Used only for negative arg tests, which
# return before any privileged pre-flight work.
plan_strict() {
  run env -u PCT_DRY_RUN bash "$SCRIPT" "$@"
}

# --- argument / usage handling ---------------------------------------------

@test "--help prints usage and exits 0" {
  plan --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: install-client.sh"* ]]
}

@test "a real run requires --server-url" {
  plan_strict --enrolment-token T --supervised-user alice
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing --server-url"* ]]
}

@test "a real run requires --enrolment-token" {
  plan_strict --server-url https://dash.lan --supervised-user alice
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing --enrolment-token"* ]]
}

@test "a real run requires at least one supervised user" {
  plan_strict --server-url https://dash.lan --enrolment-token T
  [ "$status" -ne 0 ]
  [[ "$output" == *"no supervised users given"* ]]
}

@test "a dry-run preview fills placeholders for missing inputs (CI smoke contract)" {
  # Mirrors .github/workflows/integration.yml: a minimal-deps container runs the
  # script with only PCT_SERVER_URL + PCT_DRY_RUN and expects a clean exit.
  PCT_SERVER_URL=http://mock.local run env bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"placeholder"* ]]
  [[ "$output" == *"client enrolment complete for: exampleuser"* ]]
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
  [[ "$output" == *"Installing timekpr-next from the distribution repositories"* ]]
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
  [[ "$output" == *'"sshUser":"pct-agent"'* ]]
  [[ "$output" == *'"osUsername":"alice"'* ]]
  # osUserRef is the OS-neutral account reference (#230), a JSON string (the
  # numeric uid in decimal-string form on Linux).
  [[ "$output" == *'"osUserRef":"'* ]]
}

@test "--ssh-user overrides the SSH principal in the enrol body" {
  ok_args --ssh-user customagent
  [ "$status" -eq 0 ]
  [[ "$output" == *'"sshUser":"customagent"'* ]]
}

# --- version reporting (#164) ----------------------------------------------

@test "reports the detected agent + component versions in the enrol body (#164)" {
  export PCT_AGENT_VERSION=1.4.0
  export PCT_TIMEKPR_VERSION=0.5.3
  export PCT_ACTIVITYWATCH_VERSION=0.13.2
  # e2guardian is intentionally left undetected; pin its probe at a missing
  # binary so the "omitted" assertion stays hermetic on hosts that have it.
  export PCT_E2GUARDIAN=pct-no-such-binary
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *'"agentVersion":"1.4.0"'* ]]
  [[ "$output" == *'"componentVersions":{'* ]]
  [[ "$output" == *'"timekpr":"0.5.3"'* ]]
  [[ "$output" == *'"activitywatch":"0.13.2"'* ]]
  # e2guardian was not detected, so its key is omitted (not reported as empty).
  [[ "$output" != *'"e2guardian"'* ]]
}

@test "omits the version fields entirely when nothing can be detected (#164)" {
  # Point every probe at a non-existent binary so detection is hermetic
  # regardless of what the test host happens to have installed.
  export PCT_DPKG_QUERY=pct-no-such-binary
  export PCT_TIMEKPRA=pct-no-such-binary
  export PCT_E2GUARDIAN=pct-no-such-binary
  export PCT_AWSERVER=pct-no-such-binary
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" != *'"agentVersion"'* ]]
  [[ "$output" != *'"componentVersions"'* ]]
}

@test "reduces a tool's version output to a plain dotted token, dropping unsafe text (#164)" {
  # A version carrying a quote + shell metacharacters is reduced to just the
  # dotted token, so nothing can break out of the JSON string.
  export PCT_AGENT_VERSION='1.4.0"; rm -rf /'
  # A tool whose name contains a digit must still resolve to the version, not
  # the name (the dot requirement guards this).
  export PCT_E2GUARDIAN_VERSION='e2guardian 5.5.8'
  # Pin the un-overridden probes at a missing binary so the body is hermetic.
  export PCT_TIMEKPRA=pct-no-such-binary
  export PCT_AWSERVER=pct-no-such-binary
  ok_args
  [ "$status" -eq 0 ]
  [[ "$output" == *'"agentVersion":"1.4.0"'* ]]
  [[ "$output" == *'"e2guardian":"5.5.8"'* ]]
  [[ "$output" != *'rm -rf'* ]]
  # The digit in the tool name must not be mistaken for the version value.
  [[ "$output" != *':"2guardian"'* ]]
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

@test "persists the per-client bearer token credential (0600 from birth)" {
  export PCT_FAKE_ENROL_RESPONSE='{"clientId":7,"hostname":"h","sshUser":"pct-agent","bearerToken":"BEARER-XYZ","sshPublicKey":null,"supervisedUsers":[]}'
  ok_args
  [ "$status" -eq 0 ]
  # The plan creates the file 0600 before writing the secret (no world-readable
  # window), not a post-hoc chmod.
  [[ "$output" == *"install -m 0600 ${PCT_STATE_DIR}/pct-client.env"* ]]
  [[ "$output" == *"client credentials stored at ${PCT_STATE_DIR}/pct-client.env"* ]]
}

# --- self-test hook --------------------------------------------------------

@test "notes the self-test is pending when it is not installed" {
  # Point at a guaranteed-absent path: now that the self-test (#80) lives at
  # the orchestrator's default ${PCT_INSTALL_DIR}/self-test.sh, the "pending"
  # branch must be exercised deterministically rather than relying on the repo
  # not shipping one.
  PCT_SELF_TEST="${TMP}/no-such-self-test.sh" ok_args
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

# --- real enrol request (function-level, with a curl stub) -----------------

@test "a failed enrol request aborts with a clear error (real run)" {
  local stub="${TMP}/curl-fail"
  printf '#!/usr/bin/env bash\nexit 22\n' >"$stub"
  chmod +x "$stub"
  # Source the (guarded) orchestrator and drive pct_orch_enrol directly so we
  # exercise the real-run path without needing root for the earlier steps.
  run env -u PCT_DRY_RUN bash -c '
    PCT_CURL="'"$stub"'"
    source "'"$SCRIPT"'"
    pct_orch_enrol https://dash.lan TOK host pct-agent alice 1000
  '
  [ "$status" -ne 0 ]
  [[ "$output" == *"enrolment request to https://dash.lan/api/clients/enrol failed"* ]]
}

@test "the enrolment token is sent via stdin config, never on the curl argv" {
  local stub="${TMP}/curl-echo"
  cat >"$stub" <<'EOS'
#!/usr/bin/env bash
echo "ARGV: $*"
echo "STDIN: $(cat)"
EOS
  chmod +x "$stub"
  run env -u PCT_DRY_RUN bash -c '
    PCT_CURL="'"$stub"'"
    source "'"$SCRIPT"'"
    pct_orch_enrol https://dash.lan SECRETTOKEN host pct-agent alice 1000
  '
  [ "$status" -eq 0 ]
  local argv_line stdin_line
  argv_line="$(printf '%s\n' "$output" | grep '^ARGV:')"
  stdin_line="$(printf '%s\n' "$output" | grep '^STDIN:')"
  # The secret must not appear in the argv curl received (ps-visibility) ...
  [[ "$argv_line" != *SECRETTOKEN* ]]
  # ... but must be delivered through the stdin config file.
  [[ "$stdin_line" == *"Authorization: Bearer SECRETTOKEN"* ]]
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
