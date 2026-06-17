#!/usr/bin/env bats
#
# Tests for client/lib/provision-agent-user.sh (issue #78).
#
# The script's side-effecting commands (getent/useradd/chown/visudo) are
# replaced with PATH stubs so the real branching logic — idempotency guards,
# sudoers rendering/validation, authorized_keys dedupe — runs unprivileged in
# a tmpdir. Target paths are redirected via the script's documented env knobs.

setup() {
  TESTDIR="$(mktemp -d)"
  STUBBIN="${TESTDIR}/bin"
  STATE="${TESTDIR}/state"
  FAKE_HOME="${TESTDIR}/home/pct-agent"
  mkdir -p "${STUBBIN}" "${STATE}"

  export PCT_AGENT_USER="pct-agent"
  export PCT_SUDOERS_DIR="${TESTDIR}/sudoers.d"
  export PCT_TIMEKPRA_PATH="/usr/bin/timekpra"
  export PCT_VISUDO="visudo"
  export PATH="${STUBBIN}:${PATH}"

  SCRIPT="${BATS_TEST_DIRNAME}/../lib/provision-agent-user.sh"

  # getent stub: user is "missing" (exit 2) until useradd marks it present.
  cat >"${STUBBIN}/getent" <<EOF
#!/usr/bin/env bash
if [ "\$1" = passwd ] && [ "\$2" = "${PCT_AGENT_USER}" ]; then
  if [ -f "${STATE}/user_exists" ]; then
    echo "${PCT_AGENT_USER}:x:998:998::${FAKE_HOME}:/bin/bash"
    exit 0
  fi
  exit 2
fi
exit 2
EOF

  # useradd stub: records the call, marks the user present, creates the home.
  cat >"${STUBBIN}/useradd" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"${STATE}/useradd.log"
touch "${STATE}/user_exists"
mkdir -p "${FAKE_HOME}"
EOF

  # chown stub: no-op (cannot chown to root unprivileged).
  cat >"${STUBBIN}/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  # visudo stub: validates (exit 0) unless a test forces FAKE_VISUDO_RC.
  cat >"${STUBBIN}/visudo" <<'EOF'
#!/usr/bin/env bash
exit "${FAKE_VISUDO_RC:-0}"
EOF

  chmod +x "${STUBBIN}"/*
}

teardown() {
  rm -rf "${TESTDIR}"
}

sudoers_file() {
  echo "${PCT_SUDOERS_DIR}/pct-agent"
}

@test "creates the pct-agent system account when it is missing" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [ -f "${STATE}/useradd.log" ]
  grep -q -- "--system" "${STATE}/useradd.log"
  grep -q -- "--create-home" "${STATE}/useradd.log"
  grep -q -- "${PCT_AGENT_USER}" "${STATE}/useradd.log"
}

@test "is idempotent: does not re-create an existing account" {
  touch "${STATE}/user_exists"
  mkdir -p "${FAKE_HOME}"
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [ ! -f "${STATE}/useradd.log" ]
}

@test "installs the scoped sudoers drop-in with 0440 perms" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  local f
  f="$(sudoers_file)"
  [ -f "${f}" ]
  # exactly the timekpra grant, nothing broader
  grep -qx "${PCT_AGENT_USER} ALL=(root) NOPASSWD: ${PCT_TIMEKPRA_PATH}" "${f}"
  [ "$(stat -c '%a' "${f}")" = "440" ]
}

@test "grants no privilege beyond the single timekpra command" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  local f
  f="$(sudoers_file)"
  # only one non-comment, non-blank directive in the file
  [ "$(grep -cvE '^\s*(#.*)?$' "${f}")" -eq 1 ]
  # and it must not be a blanket ALL grant
  ! grep -qE 'NOPASSWD:\s*ALL' "${f}"
}

@test "sudoers install is idempotent (stable content, no duplication)" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  local f before after
  f="$(sudoers_file)"
  before="$(cat "${f}")"
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  after="$(cat "${f}")"
  [ "${before}" = "${after}" ]
}

@test "aborts without installing when visudo validation fails" {
  export FAKE_VISUDO_RC=1
  run bash "${SCRIPT}"
  [ "${status}" -ne 0 ]
  [ ! -f "$(sudoers_file)" ]
}

@test "authorizes an inline SSH key with 0700/.ssh and 0600/authorized_keys" {
  local key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA dashboard@pct"
  run bash "${SCRIPT}" --ssh-key-string "${key}"
  [ "${status}" -eq 0 ]
  [ "$(stat -c '%a' "${FAKE_HOME}/.ssh")" = "700" ]
  [ "$(stat -c '%a' "${FAKE_HOME}/.ssh/authorized_keys")" = "600" ]
  grep -qxF -- "${key}" "${FAKE_HOME}/.ssh/authorized_keys"
}

@test "authorizes an SSH key read from a file" {
  local key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5BBBB dashboard@pct"
  local kf="${TESTDIR}/dashboard.pub"
  printf '%s\n' "${key}" >"${kf}"
  run bash "${SCRIPT}" --ssh-key "${kf}"
  [ "${status}" -eq 0 ]
  grep -qxF -- "${key}" "${FAKE_HOME}/.ssh/authorized_keys"
}

@test "does not duplicate an already-authorized SSH key" {
  local key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5CCCC dashboard@pct"
  run bash "${SCRIPT}" --ssh-key-string "${key}"
  [ "${status}" -eq 0 ]
  run bash "${SCRIPT}" --ssh-key-string "${key}"
  [ "${status}" -eq 0 ]
  [ "$(grep -cxF -- "${key}" "${FAKE_HOME}/.ssh/authorized_keys")" -eq 1 ]
}

@test "skips authorized_keys when no key is supplied" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [ ! -e "${FAKE_HOME}/.ssh/authorized_keys" ]
}

@test "fails on an unreadable ssh key file" {
  run bash "${SCRIPT}" --ssh-key "${TESTDIR}/nope.pub"
  [ "${status}" -ne 0 ]
}

@test "fails on an unknown argument" {
  run bash "${SCRIPT}" --bogus
  [ "${status}" -ne 0 ]
}

@test "replaces stale sudoers content rather than leaving it" {
  mkdir -p "${PCT_SUDOERS_DIR}"
  printf 'pct-agent ALL=(root) NOPASSWD: /usr/bin/somethingelse\n' >"$(sudoers_file)"
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -qx "${PCT_AGENT_USER} ALL=(root) NOPASSWD: ${PCT_TIMEKPRA_PATH}" "$(sudoers_file)"
  ! grep -q "somethingelse" "$(sudoers_file)"
}

@test "preserves pre-existing authorized_keys entries (append, not overwrite)" {
  touch "${STATE}/user_exists"
  mkdir -p "${FAKE_HOME}/.ssh"
  local other="ssh-rsa AAAApreexisting other@host"
  printf '%s\n' "${other}" >"${FAKE_HOME}/.ssh/authorized_keys"
  local key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5DDDD dashboard@pct"
  run bash "${SCRIPT}" --ssh-key-string "${key}"
  [ "${status}" -eq 0 ]
  grep -qxF -- "${other}" "${FAKE_HOME}/.ssh/authorized_keys"
  grep -qxF -- "${key}" "${FAKE_HOME}/.ssh/authorized_keys"
}

@test "rejects a multi-line ssh key" {
  touch "${STATE}/user_exists"
  mkdir -p "${FAKE_HOME}"
  run bash "${SCRIPT}" --ssh-key-string $'ssh-ed25519 AAAA one\nssh-ed25519 BBBB two'
  [ "${status}" -ne 0 ]
}

# --- sourceable-library contract (the module is sourced by the orchestrator #76) ---

@test "sourcing the module does not change the caller's shell options" {
  run bash -c 'before="$-"; source "'"${SCRIPT}"'"; after="$-"; [ "${before}" = "${after}" ]'
  [ "${status}" -eq 0 ]
}

@test "a sourced error path returns non-zero without exiting the caller" {
  # The caller has no errexit; an internal failure must `return`, not `exit`,
  # so the line after the call still runs.
  run bash -c 'source "'"${SCRIPT}"'"; pct_provision_agent_user --bogus; echo "after=$?"'
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"after=1"* ]]
}
