#!/usr/bin/env bash
#
# self-test.sh — post-install self-test for a supervised Linux client
# (linux-parental-controls-toolkit, Phase 3, issue #80).
#
# Runs at the end of client/install-client.sh (#76) and reports a clear
# pass/fail per component, exiting non-zero if anything is wrong so the
# installer surfaces a broken enrolment. Per docs/client-install.md -> step 9
# and docs/roadmap.md -> Phase 3.
#
# The checks are READ-ONLY probes of state the earlier install steps laid
# down (the pct-agent account + scoped sudoers #78, the baseline tools #79,
# the dashboard enrolment #76/#77):
#
#   1. the pct-agent service account exists
#   2. the dashboard SSH key is authorized for pct-agent (and sshd is up)
#   3. the pct-agent sudoers drop-in is scoped to exactly `timekpra`
#   4. the Timekpr-nExT daemon is up and `timekpra` answers for each user
#   5. aw-server is reachable on loopback and returns buckets
#   6. e2guardian is active
#   7. the dashboard enrolment record is present
#
# This is the client-side complement to the admin "Clients" health page (#81),
# which shows the same component states from the server's perspective.
#
# License boundary (docs/licensing-analysis.md): pure bash. The GPL tools are
# only ever poked as a subprocess (`timekpra`) or over their loopback REST API
# (aw-server) — never linked, never vendored. Tamper-resistance posture
# (docs/client-install.md): this only *verifies* the least-privilege baseline;
# it adds no hardening beyond the documented ceiling.
#
# The script is dry-run aware: PCT_DRY_RUN=1 prints the intended probes as a
# side-effect-free preview and exits 0 (there is nothing to check on a machine
# the script must not touch). That, and the per-binary env overrides below, are
# how CI and the bats tests exercise it without root, network, or the tools
# installed.
#
# Sourceable: install-client.sh (#76) runs it as a subprocess
# (`PCT_SELF_TEST`/`<install-dir>/self-test.sh`), passing the supervised users
# via PCT_SUPERVISED_LIST. It is also directly runnable for standalone use and
# sourced by the bats suite to exercise individual checks.
#
#   sudo bash client/self-test.sh --supervised-user alice
#   PCT_SUPERVISED_LIST="alice bob" bash client/self-test.sh
#   PCT_DRY_RUN=1 bash client/self-test.sh --supervised-user alice

set -uo pipefail

# Resolve our own directory so the shared helpers source whether the script is
# run directly or sourced from the orchestrator.
PCT_SELFTEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=client/lib/pct-common.sh
. "${PCT_SELFTEST_DIR}/lib/pct-common.sh"

# --- overridable knobs (defaults match a real Mint client) -----------------
#
# Every external binary / path is overridable so the tests can stub it without
# root, network, or the upstream tools present (the pattern established by
# provision-agent-user.sh / install-baseline-tools.sh).

PCT_AGENT_USER="${PCT_AGENT_USER:-pct-agent}"
PCT_GETENT="${PCT_GETENT:-getent}"
PCT_SYSTEMCTL="${PCT_SYSTEMCTL:-systemctl}"
PCT_CURL="${PCT_CURL:-curl}"
PCT_TIMEKPRA="${PCT_TIMEKPRA:-timekpra}"

# Absolute path the scoped sudoers rule names (must match provision-agent-user.sh).
PCT_TIMEKPRA_PATH="${PCT_TIMEKPRA_PATH:-/usr/bin/timekpra}"
PCT_SUDOERS_DIR="${PCT_SUDOERS_DIR:-/etc/sudoers.d}"

# systemd unit names (overridable so a distro variation / test can swap them).
PCT_SSHD_SERVICE="${PCT_SSHD_SERVICE:-ssh.service}"
PCT_TIMEKPR_SERVICE="${PCT_TIMEKPR_SERVICE:-timekpr.service}"
PCT_E2GUARDIAN_SERVICE="${PCT_E2GUARDIAN_SERVICE:-e2guardian.service}"

# aw-server loopback bind (kept in step with install-baseline-tools.sh).
AW_HOST="${AW_HOST:-127.0.0.1}"
AW_PORT="${AW_PORT:-5600}"

# Where install-client.sh (#76) persists the per-client enrolment record.
PCT_STATE_DIR="${PCT_STATE_DIR:-/etc/pct}"

# sudoers ignores drop-in files whose names contain '.'/'~', so this is a plain
# token — must match PCT_SUDOERS_FILE_BASENAME in provision-agent-user.sh.
readonly PCT_SELFTEST_SUDOERS_BASENAME="pct-agent"

# --- result accounting -----------------------------------------------------

PCT_SELFTEST_PASSED=0
PCT_SELFTEST_FAILED=0

# Record a passing check (also used to render the dry-run preview line).
pct_selftest_pass() {
  PCT_SELFTEST_PASSED=$((PCT_SELFTEST_PASSED + 1))
  pct_ok "$1"
}

# Record a failing check with a human-readable reason.
pct_selftest_fail() {
  PCT_SELFTEST_FAILED=$((PCT_SELFTEST_FAILED + 1))
  pct_err "$1: $2"
}

# Under dry-run, announce a probe as a side-effect-free preview and count it as
# a (notional) pass. Returns 0 when it handled the check (caller should return),
# 1 when a real probe should run.
pct_selftest_preview() {
  if pct_is_dry_run; then
    pct_selftest_pass "would check: $1"
    return 0
  fi
  return 1
}

# --- individual checks -----------------------------------------------------

# 1. The low-privilege pct-agent service account exists (#78).
pct_selftest_agent_user() {
  local desc="pct-agent service account exists"
  pct_selftest_preview "$desc" && return 0
  if "$PCT_GETENT" passwd "$PCT_AGENT_USER" >/dev/null 2>&1; then
    pct_selftest_pass "$desc"
  else
    pct_selftest_fail "$desc" "no '${PCT_AGENT_USER}' account (run the agent-provisioning step)"
  fi
}

# pct-agent's home directory per the passwd database (first match only).
pct_selftest_agent_home() {
  "$PCT_GETENT" passwd "$PCT_AGENT_USER" 2>/dev/null | head -n1 | cut -d: -f6
}

# 2. The dashboard SSH key is authorized for pct-agent, with correct perms.
#
# Note: a full "loopback SSH as the dashboard would" needs the dashboard's
# PRIVATE key, which the client never holds — so the authenticated round-trip
# is verified server-side by the #81 Clients-health job. Here we confirm the
# client-side prerequisites: authorized_keys is present, non-empty, and locked
# down, and sshd is running so the dashboard could connect.
pct_selftest_ssh_key() {
  local desc="dashboard SSH key authorized for pct-agent"
  pct_selftest_preview "$desc" && return 0

  local home ssh_dir auth
  home="$(pct_selftest_agent_home)"
  if [ -z "$home" ]; then
    pct_selftest_fail "$desc" "cannot resolve home for '${PCT_AGENT_USER}'"
    return 0
  fi
  ssh_dir="${home}/.ssh"
  auth="${ssh_dir}/authorized_keys"

  if [ ! -s "$auth" ]; then
    pct_selftest_fail "$desc" "no non-empty ${auth} (enrolment did not authorize the key)"
    return 0
  fi
  if [ "$(pct_selftest_mode "$ssh_dir")" != "700" ]; then
    pct_selftest_fail "$desc" "${ssh_dir} should be mode 0700"
    return 0
  fi
  if [ "$(pct_selftest_mode "$auth")" != "600" ]; then
    pct_selftest_fail "$desc" "${auth} should be mode 0600"
    return 0
  fi
  pct_selftest_pass "$desc"
}

# 3. sshd is active (so the dashboard's SSH transport can reach this client).
pct_selftest_sshd() {
  pct_selftest_service "sshd is active" "$PCT_SSHD_SERVICE"
}

# 4. The pct-agent sudoers drop-in is scoped to EXACTLY `timekpra` (#78).
pct_selftest_sudoers() {
  local desc="pct-agent sudoers scoped to timekpra only"
  pct_selftest_preview "$desc" && return 0

  local target="${PCT_SUDOERS_DIR}/${PCT_SELFTEST_SUDOERS_BASENAME}"
  if [ ! -f "$target" ]; then
    pct_selftest_fail "$desc" "missing sudoers drop-in ${target}"
    return 0
  fi
  if [ "$(pct_selftest_mode "$target")" != "440" ]; then
    pct_selftest_fail "$desc" "${target} should be mode 0440"
    return 0
  fi

  # The one rule we require, and nothing broader. Compare ignoring comments and
  # blank lines so the drop-in's header doesn't trip the "nothing broader" test.
  local expected rules
  expected="${PCT_AGENT_USER} ALL=(root) NOPASSWD: ${PCT_TIMEKPRA_PATH}"
  rules="$(grep -vE '^[[:space:]]*(#|$)' "$target")"

  if ! printf '%s\n' "$rules" | grep -qxF "$expected"; then
    pct_selftest_fail "$desc" "expected exactly '${expected}'"
    return 0
  fi
  # Any rule line that is not the expected one is "broader than intended".
  if printf '%s\n' "$rules" | grep -vxF "$expected" | grep -q .; then
    pct_selftest_fail "$desc" "drop-in grants more than the single timekpra rule"
    return 0
  fi
  pct_selftest_pass "$desc"
}

# 5. The Timekpr-nExT daemon is active.
pct_selftest_timekpr_daemon() {
  pct_selftest_service "Timekpr-nExT daemon is active" "$PCT_TIMEKPR_SERVICE"
}

# 6. `timekpra --userinfo USER` answers for each supervised user (the verified
#    admin-CLI grammar the dashboard drives over SSH).
pct_selftest_timekpra_users() {
  local user
  for user in "$@"; do
    local desc="timekpra reports status for '${user}'"
    if pct_selftest_preview "$desc"; then
      continue
    fi
    if "$PCT_TIMEKPRA" --userinfo "$user" >/dev/null 2>&1; then
      pct_selftest_pass "$desc"
    else
      pct_selftest_fail "$desc" "timekpra --userinfo '${user}' failed (daemon down or user not managed)"
    fi
  done
}

# 7. aw-server is reachable on loopback and returns buckets.
pct_selftest_aw_server() {
  local desc="aw-server reachable on ${AW_HOST}:${AW_PORT}"
  pct_selftest_preview "$desc" && return 0

  local url="http://${AW_HOST}:${AW_PORT}/api/0/buckets/"
  local body
  if ! body="$("$PCT_CURL" --fail --silent --show-error --max-time 5 "$url" 2>/dev/null)"; then
    pct_selftest_fail "$desc" "no 2xx from ${url} (is the aw-server user unit running?)"
    return 0
  fi
  # The buckets endpoint returns a JSON object (`{}` when empty is still valid).
  case "$(printf '%s' "$body" | tr -d '[:space:]')" in
  '{'*)
    pct_selftest_pass "$desc"
    ;;
  *)
    pct_selftest_fail "$desc" "unexpected (non-JSON) response from ${url}"
    ;;
  esac
}

# 8. e2guardian is active.
pct_selftest_e2guardian() {
  pct_selftest_service "e2guardian is active" "$PCT_E2GUARDIAN_SERVICE"
}

# 9. The dashboard enrolment record is present and locked down (#76/#77).
pct_selftest_enrolment() {
  local desc="client enrolled with the dashboard"
  pct_selftest_preview "$desc" && return 0

  local env_file="${PCT_STATE_DIR}/pct-client.env"
  if [ ! -f "$env_file" ]; then
    pct_selftest_fail "$desc" "missing enrolment record ${env_file}"
    return 0
  fi
  if [ "$(pct_selftest_mode "$env_file")" != "600" ]; then
    pct_selftest_fail "$desc" "${env_file} should be mode 0600 (it holds the bearer token)"
    return 0
  fi
  if ! pct_selftest_env_has "$env_file" PCT_CLIENT_ID; then
    pct_selftest_fail "$desc" "${env_file} has no PCT_CLIENT_ID"
    return 0
  fi
  if ! pct_selftest_env_has "$env_file" PCT_CLIENT_BEARER_TOKEN; then
    pct_selftest_fail "$desc" "${env_file} has no PCT_CLIENT_BEARER_TOKEN"
    return 0
  fi
  pct_selftest_pass "$desc"
}

# --- small probe helpers ---------------------------------------------------

# Octal permission bits of a path (e.g. "600"), or empty if it does not exist.
pct_selftest_mode() {
  stat -c '%a' "$1" 2>/dev/null
}

# True if the env file assigns a non-empty value to KEY (KEY=<something>).
pct_selftest_env_has() {
  grep -qE "^${2}=.+" "$1" 2>/dev/null
}

# Shared "systemd unit is active" check used by several probes above.
pct_selftest_service() {
  local desc="$1" unit="$2"
  pct_selftest_preview "$desc" && return 0
  local state
  state="$("$PCT_SYSTEMCTL" is-active "$unit" 2>/dev/null)"
  if [ "$state" = "active" ]; then
    pct_selftest_pass "$desc"
  else
    pct_selftest_fail "$desc" "${unit} is '${state:-unknown}', expected 'active'"
  fi
}

# --- orchestration ---------------------------------------------------------

pct_self_test() {
  # Args: the supervised Linux usernames whose timekpr status to check.
  if [ "$#" -eq 0 ]; then
    pct_err "no supervised users given; pass at least one --supervised-user"
    return 2
  fi

  pct_step "Post-install self-test"
  if pct_is_dry_run; then
    pct_log "(dry-run: probing nothing; printing the intended checks)"
  fi

  pct_selftest_agent_user
  pct_selftest_ssh_key
  pct_selftest_sshd
  pct_selftest_sudoers
  pct_selftest_timekpr_daemon
  pct_selftest_timekpra_users "$@"
  pct_selftest_aw_server
  pct_selftest_e2guardian
  pct_selftest_enrolment

  local total=$((PCT_SELFTEST_PASSED + PCT_SELFTEST_FAILED))
  if [ "$PCT_SELFTEST_FAILED" -eq 0 ]; then
    pct_ok "self-test passed: ${PCT_SELFTEST_PASSED}/${total} checks green"
    return 0
  fi
  pct_err "self-test found problems: ${PCT_SELFTEST_FAILED}/${total} checks failed (see [error] lines above)"
  return 1
}

# --- CLI -------------------------------------------------------------------

pct_selftest_usage() {
  cat >&2 <<'EOF'
Usage: self-test.sh [--supervised-user USER ...]

Read-only post-install self-test for a supervised client. Reports a pass/fail
per component (pct-agent + sudoers, SSH key, Timekpr-nExT, ActivityWatch,
e2guardian, dashboard enrolment) and exits non-zero if any check fails.

Options:
  --supervised-user USER   A supervised Linux account to check (repeatable).
                           May also be supplied via PCT_SUPERVISED_LIST (the
                           orchestrator's space-separated list) or
                           PCT_SUPERVISED_USERS.
  -h, --help               Show this help.

Environment:
  PCT_DRY_RUN=1            Print the intended checks without probing anything.
EOF
}

pct_selftest_main() {
  local users=()
  # Seed from the orchestrator's list, then the parity env var, then flags.
  if [ -n "${PCT_SUPERVISED_LIST:-}" ]; then
    # shellcheck disable=SC2206  # intentional word-split of a space list
    users=(${PCT_SUPERVISED_LIST})
  elif [ -n "${PCT_SUPERVISED_USERS:-}" ]; then
    # shellcheck disable=SC2206  # intentional word-split of a space list
    users=(${PCT_SUPERVISED_USERS})
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
    --supervised-user)
      [ "$#" -ge 2 ] || {
        pct_err "--supervised-user needs a value"
        return 2
      }
      users+=("$2")
      shift 2
      ;;
    --supervised-user=*)
      users+=("${1#*=}")
      shift
      ;;
    -h | --help)
      pct_selftest_usage
      return 0
      ;;
    *)
      pct_err "unknown argument: $1"
      pct_selftest_usage
      return 2
      ;;
    esac
  done
  if [ "${#users[@]}" -eq 0 ]; then
    pct_err "no supervised users given"
    pct_selftest_usage
    return 2
  fi
  pct_self_test "${users[@]}"
}

# Run main only when executed directly, not when sourced (by the orchestrator
# or the bats suite).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  pct_selftest_main "$@"
fi
