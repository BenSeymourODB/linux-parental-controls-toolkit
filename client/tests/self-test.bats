#!/usr/bin/env bats
#
# Unit tests for client/self-test.sh (issue #80). Every external probe
# (getent / systemctl / curl / timekpra) is pointed at a tiny stub whose
# behaviour is env-controlled, and the file-based checks (sudoers, SSH key,
# enrolment record) read fixtures under a tmpdir — so the full pass/fail logic
# runs without root, network, or the upstream tools.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../self-test.sh"
  TMP="$(mktemp -d)"
  BIN="${TMP}/bin"
  mkdir -p "$BIN"

  # --- stubs -------------------------------------------------------------
  # getent passwd <user> -> emit a passwd line with home = $STUB_AGENT_HOME,
  # or exit non-zero when $STUB_AGENT_EXISTS != 1.
  cat >"${BIN}/getent" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_AGENT_EXISTS:-1}" = "1" ] || exit 2
printf '%s:x:998:998:pct-agent:%s:/bin/bash\n' "$2" "${STUB_AGENT_HOME}"
EOF

  # systemctl is-active <unit> -> "active" unless the unit is $STUB_INACTIVE_UNIT.
  cat >"${BIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
if [ "$2" = "${STUB_INACTIVE_UNIT:-}" ]; then echo inactive; exit 3; fi
echo active
EOF

  # curl ... -> a JSON object, unless told to fail or return a non-JSON body.
  cat >"${BIN}/curl" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_CURL_FAIL:-0}" = "1" ] && exit 22
if [ "${STUB_CURL_BADBODY:-0}" = "1" ]; then printf '<html>nope</html>'; exit 0; fi
printf '{"aw-watcher-window_host":{}}'
EOF

  # timekpra --userinfo <user> -> succeed unless told to fail.
  cat >"${BIN}/timekpra" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_TIMEKPRA_FAIL:-0}" = "1" ] && exit 1
printf 'TIME_SPENT_DAY: 0\n'
EOF
  chmod +x "${BIN}"/*

  # --- passing fixtures --------------------------------------------------
  STUB_AGENT_HOME="${TMP}/agenthome"
  mkdir -p "${STUB_AGENT_HOME}/.ssh"
  printf 'ssh-ed25519 AAAA...dashboard\n' >"${STUB_AGENT_HOME}/.ssh/authorized_keys"
  chmod 700 "${STUB_AGENT_HOME}/.ssh"
  chmod 600 "${STUB_AGENT_HOME}/.ssh/authorized_keys"

  SUDOERS_DIR="${TMP}/sudoers.d"
  mkdir -p "$SUDOERS_DIR"
  cat >"${SUDOERS_DIR}/pct-agent" <<'EOF'
# Managed by linux-parental-controls-toolkit — pct-agent service account.
# DO NOT EDIT BY HAND.
pct-agent ALL=(root) NOPASSWD: /usr/bin/timekpra
EOF
  chmod 440 "${SUDOERS_DIR}/pct-agent"

  STATE_DIR="${TMP}/state"
  mkdir -p "$STATE_DIR"
  cat >"${STATE_DIR}/pct-client.env" <<'EOF'
PCT_SERVER_URL=https://dash.lan
PCT_CLIENT_ID=7
PCT_CLIENT_BEARER_TOKEN=deadbeef
EOF
  chmod 600 "${STATE_DIR}/pct-client.env"

  # --- wire the script at the stubs/fixtures -----------------------------
  export PCT_GETENT="${BIN}/getent"
  export PCT_SYSTEMCTL="${BIN}/systemctl"
  export PCT_CURL="${BIN}/curl"
  export PCT_TIMEKPRA="${BIN}/timekpra"
  export PCT_SUDOERS_DIR="$SUDOERS_DIR"
  export PCT_STATE_DIR="$STATE_DIR"
  export STUB_AGENT_HOME
}

teardown() {
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
}

run_selftest() { run env bash "$SCRIPT" "$@"; }

@test "requires at least one supervised user" {
  run_selftest
  [ "$status" -eq 2 ]
  [[ "$output" == *"no supervised users given"* ]]
}

@test "--help prints usage and exits 0" {
  run_selftest --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: self-test.sh"* ]]
}

@test "all checks green -> exit 0 with a summary" {
  run_selftest --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"self-test passed"* ]]
  [[ "$output" == *"checks green"* ]]
  [[ "$output" == *"[ok] pct-agent service account exists"* ]]
  [[ "$output" == *"[ok] dashboard SSH key authorized for pct-agent"* ]]
  [[ "$output" == *"[ok] timekpra reports status for 'alice'"* ]]
  [[ "$output" == *"[ok] aw-server reachable on 127.0.0.1:5600"* ]]
  [[ "$output" == *"[ok] client enrolled with the dashboard"* ]]
}

@test "missing pct-agent account -> failure" {
  STUB_AGENT_EXISTS=0 run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"[error] pct-agent service account exists"* ]]
}

@test "empty authorized_keys -> SSH key check fails" {
  : >"${STUB_AGENT_HOME}/.ssh/authorized_keys"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"[error] dashboard SSH key authorized for pct-agent"* ]]
  [[ "$output" == *"enrolment did not authorize the key"* ]]
}

@test "world-readable authorized_keys -> SSH key check fails on perms" {
  chmod 644 "${STUB_AGENT_HOME}/.ssh/authorized_keys"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"should be mode 0600"* ]]
}

@test "inactive sshd -> failure" {
  STUB_INACTIVE_UNIT=ssh.service run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"[error] sshd is active"* ]]
}

@test "missing sudoers drop-in -> failure" {
  rm -f "${PCT_SUDOERS_DIR}/pct-agent"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing sudoers drop-in"* ]]
}

@test "broader sudoers grant -> failure" {
  printf 'pct-agent ALL=(ALL) NOPASSWD: ALL\n' >>"${PCT_SUDOERS_DIR}/pct-agent"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"[error] pct-agent sudoers scoped to timekpra only"* ]]
  [[ "$output" == *"more than the single timekpra rule"* ]]
}

@test "wrong sudoers mode -> failure" {
  chmod 644 "${PCT_SUDOERS_DIR}/pct-agent"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"should be mode 0440"* ]]
}

@test "timekpra failing for a user -> failure" {
  STUB_TIMEKPRA_FAIL=1 run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"[error] timekpra reports status for 'alice'"* ]]
}

@test "aw-server unreachable -> failure" {
  STUB_CURL_FAIL=1 run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"no 2xx from"* ]]
}

@test "aw-server non-JSON body -> failure" {
  STUB_CURL_BADBODY=1 run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"unexpected (non-JSON) response"* ]]
}

@test "inactive e2guardian -> failure" {
  STUB_INACTIVE_UNIT=e2guardian.service run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"[error] e2guardian is active"* ]]
}

@test "missing enrolment record -> failure" {
  rm -f "${PCT_STATE_DIR}/pct-client.env"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing enrolment record"* ]]
}

@test "enrolment record without bearer token -> failure" {
  printf 'PCT_CLIENT_ID=7\n' >"${PCT_STATE_DIR}/pct-client.env"
  chmod 600 "${PCT_STATE_DIR}/pct-client.env"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"no PCT_CLIENT_BEARER_TOKEN"* ]]
}

@test "world-readable enrolment record -> failure on perms" {
  chmod 644 "${PCT_STATE_DIR}/pct-client.env"
  run_selftest --supervised-user alice
  [ "$status" -eq 1 ]
  [[ "$output" == *"should be mode 0600"* ]]
}

@test "checks each supervised user from PCT_SUPERVISED_LIST" {
  PCT_SUPERVISED_LIST="alice bob" run_selftest
  [ "$status" -eq 0 ]
  [[ "$output" == *"timekpra reports status for 'alice'"* ]]
  [[ "$output" == *"timekpra reports status for 'bob'"* ]]
}

@test "dry-run previews the checks without probing and exits 0" {
  # Point the probes at a non-existent path: if dry-run actually invoked them
  # the run would error, proving the preview short-circuits before any probe.
  PCT_DRY_RUN=1 PCT_GETENT=/nonexistent PCT_SYSTEMCTL=/nonexistent \
    PCT_CURL=/nonexistent PCT_TIMEKPRA=/nonexistent \
    run env bash "$SCRIPT" --supervised-user alice
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [[ "$output" == *"would check: pct-agent service account exists"* ]]
  [[ "$output" == *"would check: timekpra reports status for 'alice'"* ]]
}
