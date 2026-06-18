#!/usr/bin/env bash
#
# install-client.sh — the Phase 3 anchor (#76): one command turns a fresh
# Linux Mint (Cinnamon) desktop into an enrolled, supervised client.
#
# This is the ORCHESTRATOR. It sequences the Phase-3 sub-steps that each landed
# as their own component (and have their own tests); it does not re-implement
# them:
#
#   1. provision the low-privilege `pct-agent` service account + scoped sudoers
#        -> client/lib/provision-agent-user.sh (#78)
#   2. install + baseline-configure the upstream enforcement/telemetry tools
#        -> client/install-baseline-tools.sh (#79)
#   3. register the client with the dashboard and receive the per-client bearer
#      token + the dashboard SSH public key
#        -> POST <server>/api/clients/enrol (#77)
#   4. authorize that SSH key for pct-agent and persist the bearer token
#   5. run the post-install self-test (#80) if it is installed
#
# License boundary (docs/licensing-analysis.md): this is pure bash orchestration.
# The GPL tools come from the distribution's package manager / the projects' own
# upstream releases (handled by install-baseline-tools.sh) — never vendored into
# this repository, never linked in-process, never bundled into the dashboard
# image. ActivityWatch is only ever reached over its REST API.
#
# Tamper-resistance posture (docs/client-install.md): this lays down a least-
# privilege baseline (the pct-agent NOPASSWD-timekpra rule), not lockdown.
# Nothing here exists to "make circumvention harder".
#
# Idempotent and re-runnable: each sub-step reconciles rather than re-bootstraps.
# A second enrolment needs a fresh token (enrolment tokens are single-use); the
# orchestrator surfaces the server's rejection cleanly rather than masking it.
#
# Dry-run aware: set PCT_DRY_RUN=1 to print the intended plan without touching
# the system, network, or the upstream tools — that is how CI and the bats tests
# exercise it without root. A dry run has no side effects.
#
#   sudo bash client/install-client.sh \
#       --server-url https://parentalcontrols.lan \
#       --enrolment-token <one-time token from dashboard> \
#       --supervised-user alice
#   PCT_DRY_RUN=1 bash client/install-client.sh --server-url … --enrolment-token … --supervised-user alice

set -euo pipefail

# Resolve our own directory so the sub-step components can be sourced whether the
# script is run from the repo, copied elsewhere, or piped through `bash`.
PCT_INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source order matters. provision-agent-user.sh defines its own pct_log/pct_die
# (it deliberately does not depend on pct-common). We source it FIRST, then
# pct-common.sh, so the shared "pct:" logging wins for the orchestrator and the
# baseline step; pct_die (only defined by provision) survives either way.
# shellcheck source=client/lib/provision-agent-user.sh
. "${PCT_INSTALL_DIR}/lib/provision-agent-user.sh"
# shellcheck source=client/lib/pct-common.sh
. "${PCT_INSTALL_DIR}/lib/pct-common.sh"
# shellcheck source=client/install-baseline-tools.sh
. "${PCT_INSTALL_DIR}/install-baseline-tools.sh"

# The SSH principal the dashboard connects as. Defaults to the pct-agent account
# name provision-agent-user.sh manages; override in lockstep with it.
PCT_SSH_USER="${PCT_SSH_USER:-${PCT_AGENT_USER:-pct-agent}}"
# Where the per-client credential hand-off file is written. The Phase-8b
# pct-client-bridge (#101) reads this; overridable so tests don't touch /etc.
PCT_STATE_DIR="${PCT_STATE_DIR:-/etc/pct}"
# curl binary, overridable for tests. curl is the only external tool the
# orchestrator itself needs (the enrol request/response JSON is handled in pure
# bash — see pct_orch_build_enrol_body / pct_orch_json_*).
PCT_CURL="${PCT_CURL:-curl}"

# --- usage -----------------------------------------------------------------

pct_orch_usage() {
  cat >&2 <<'EOF'
Usage: install-client.sh --server-url URL --enrolment-token TOKEN \
                         --supervised-user USER [--supervised-user USER ...]

Enrols this Linux Mint / Ubuntu-family desktop as a supervised client: it
provisions the pct-agent service account, installs and baseline-configures the
upstream tools, registers with the dashboard, and runs the self-test.

Run as root (via sudo) for a real install.

Options:
  --server-url URL          Dashboard base URL (e.g. https://parentalcontrols.lan).
                            May also be supplied via PCT_SERVER_URL.
  --enrolment-token TOKEN   One-time enrolment token minted by the dashboard's
                            "Add client" flow. Prefer PCT_ENROLMENT_TOKEN (the
                            CLI value is visible to other users via `ps`).
  --supervised-user USER    A Linux account to supervise (repeatable). May also
                            be supplied via PCT_SUPERVISED_USERS (space list).
  --ssh-user NAME           SSH principal the dashboard connects as
                            (default: pct-agent).
  -h, --help                Show this help.

Environment:
  PCT_DRY_RUN=1             Print the plan without changing anything.
EOF
}

# --- pre-flight ------------------------------------------------------------

# Confirm we can do privileged work (real installs need root). Skipped under
# dry-run so the plan can be produced unprivileged.
pct_orch_require_root() {
  if pct_is_dry_run; then
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    pct_err "must run as root (use sudo); re-run with PCT_DRY_RUN=1 to preview without root"
    return 1
  fi
}

# Confirm the external tools the orchestrator itself needs are on PATH. curl is
# the only one (JSON is handled in pure bash); it ships with Mint/Ubuntu.
pct_orch_require_tools() {
  if ! command -v "$PCT_CURL" >/dev/null 2>&1; then
    pct_err "missing required tool: ${PCT_CURL} (install it and retry)"
    return 1
  fi
}

# Best-effort reachability probe of the dashboard. We do not require a 2xx (the
# base URL may legitimately 404 or redirect); we only confirm the host answers,
# so a typo'd URL or an unreachable server fails fast before we change anything.
pct_orch_check_reachable() {
  local url="$1"
  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "${PCT_CURL} -sS -o /dev/null --max-time 10 ${url}" >&2
    return 0
  fi
  if "$PCT_CURL" --silent --show-error --output /dev/null --max-time 10 "$url" >/dev/null 2>&1; then
    pct_ok "dashboard reachable at ${url}"
  else
    pct_err "dashboard not reachable at ${url} (check --server-url and network connectivity)"
    return 1
  fi
}

# Resolve a supervised user's Linux UID, echoing it on stdout. Under dry-run an
# absent user yields a placeholder UID so the plan can still be built; under a
# real run a missing user is a hard error (we cannot enrol a mapping for it).
pct_orch_resolve_uid() {
  local user="$1" uid
  if uid="$(id -u "$user" 2>/dev/null)"; then
    printf '%s' "$uid"
    return 0
  fi
  if pct_is_dry_run; then
    printf '%s' "0"
    return 0
  fi
  pct_err "supervised user '${user}' does not exist on this machine; create the account first"
  return 1
}

# --- enrolment -------------------------------------------------------------

# Build the JSON body for POST /api/clients/enrol from the hostname, ssh user,
# and a flat list of (username uid) pairs, matching the zod DTO (#77):
# {hostname, sshUser, supervisedUsers:[{linuxUsername, linuxUid:<number>}]}.
#
# Built in pure bash (no JSON library): safe here because every interpolated
# value is a constrained token — a Linux username (validated [<=32], the usual
# [a-z_][a-z0-9_-]* charset), a hostname (RFC-1035 charset), or an integer UID —
# none of which can contain a '"' or '\' to break out of the JSON string. The
# orchestrator's CLI parsing is the trust boundary; this is not a general JSON
# encoder and must not be reused for free-form input.
pct_orch_build_enrol_body() {
  local hostname="$1" sshuser="$2"
  shift 2
  local users_json="" sep=""
  while [ "$#" -ge 2 ]; do
    users_json="${users_json}${sep}{\"linuxUsername\":\"$1\",\"linuxUid\":$2}"
    sep=","
    shift 2
  done
  printf '{"hostname":"%s","sshUser":"%s","supervisedUsers":[%s]}' \
    "$hostname" "$sshuser" "$users_json"
}

# Extract a top-level JSON string field's value from stdin, or the empty string
# for null / a missing key. The enrol response's string fields (bearerToken,
# sshPublicKey) never contain a '"', so a non-greedy "up to the next quote"
# match is exact; null yields no match -> empty (the graceful-degrade signal).
pct_orch_json_string() {
  local field="$1" json
  json="$(cat)"
  if [[ "$json" =~ \"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# Extract a top-level JSON integer field's value from stdin, or the empty string
# if absent (e.g. clientId).
pct_orch_json_number() {
  local field="$1" json
  json="$(cat)"
  if [[ "$json" =~ \"$field\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# POST the enrolment request and echo the raw JSON response on stdout. Logs go to
# stderr so the caller can capture the body cleanly. Under dry-run the request is
# printed (never sending the token) and the response is taken from
# PCT_FAKE_ENROL_RESPONSE so the parsing path stays exercised offline.
pct_orch_enrol() {
  local server="$1" token="$2" hostname="$3" sshuser="$4"
  shift 4
  local body url
  body="$(pct_orch_build_enrol_body "$hostname" "$sshuser" "$@")"
  url="${server%/}/api/clients/enrol"

  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" \
      "${PCT_CURL} -fsS -X POST ${url} (Authorization: Bearer <redacted>) body=${body}" >&2
    if [ -n "${PCT_FAKE_ENROL_RESPONSE:-}" ]; then
      printf '%s' "$PCT_FAKE_ENROL_RESPONSE"
    else
      printf '{"clientId":0,"hostname":"%s","sshUser":"%s","bearerToken":"dry-run-token","sshPublicKey":null,"supervisedUsers":[]}' \
        "$hostname" "$sshuser"
    fi
    return 0
  fi

  # Feed the Authorization header through `curl --config -` on stdin so the
  # secret enrolment token never appears in this process's argv (and thus not in
  # `ps`). The token is base64url, so the config-file quoting is safe. The body
  # is not secret, so it stays on argv. --fail makes a non-2xx an error; the
  # endpoint returns 201 on success.
  if ! printf 'header = "Authorization: Bearer %s"\n' "$token" |
    "$PCT_CURL" --config - \
      --fail --silent --show-error --max-time 30 \
      --request POST \
      --header "Content-Type: application/json" \
      --data "$body" \
      "$url"; then
    pct_err "enrolment request to ${url} failed (the token may be expired or already used; mint a fresh one)"
    return 1
  fi
}

# Persist the per-client credentials the enrolment produced. This is the hand-off
# artifact the Phase-8b pct-client-bridge (#101) will read to authenticate to
# /api/events/stream; we only persist what registration returned. Dry-run prints
# the plan.
pct_orch_persist_credentials() {
  local server="$1" client_id="$2" bearer="$3"
  local target="${PCT_STATE_DIR}/pct-client.env"
  local content
  content="$(printf '# Managed by pct install-client.sh (#76). The Phase-8b pct-client-bridge\n# reads these to authenticate to the dashboard. Do not edit by hand.\nPCT_SERVER_URL=%s\nPCT_CLIENT_ID=%s\nPCT_CLIENT_BEARER_TOKEN=%s\n' \
    "$server" "$client_id" "$bearer")"

  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "install -m 0600 ${target} (then write PCT_CLIENT_BEARER_TOKEN)" >&2
    pct_ok "client credentials stored at ${target}"
    return 0
  fi

  mkdir -p "$(dirname "$target")"
  # Create the file 0600-from-birth BEFORE writing the secret, so there is no
  # window in which the bearer token is world-readable (a post-hoc chmod on a
  # default-umask 0644 file leaves exactly such a window). `install` makes a
  # fresh 0600 copy of the empty /dev/null, replacing any prior file.
  install -m 0600 /dev/null "$target"
  printf '%s' "$content" >"$target"
  chown root:root "$target"
  pct_ok "client credentials stored at ${target}"
}

# --- steps -----------------------------------------------------------------

# Step 3: provision the pct-agent account + scoped sudoers. provision-agent-user
# .sh is not dry-run aware, so under dry-run we print the plan instead of calling
# it (its own bats suite covers the real behaviour). The dashboard SSH key is
# authorized later (step 6) from the enrol response.
pct_orch_provision_agent() {
  pct_step "Provision the ${PCT_SSH_USER} service account + scoped sudoers"
  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" \
      "provision ${PCT_SSH_USER} service account + NOPASSWD-timekpra sudoers" >&2
    return 0
  fi
  pct_provision_agent_user
}

# Step 6: authorize the dashboard's SSH public key for pct-agent, if the enrol
# response carried one. pct_authorize_ssh_key (provision-agent-user.sh) is not
# dry-run aware, so under dry-run we print the plan.
pct_orch_authorize_key() {
  local ssh_pubkey="$1"
  pct_step "Authorize the dashboard SSH key for ${PCT_SSH_USER}"
  if [ -z "$ssh_pubkey" ]; then
    pct_warn "the dashboard returned no SSH public key yet (Phase-4 key generation pending)"
    pct_warn "authorize it for ${PCT_SSH_USER} later, before the dashboard can connect over SSH"
    return 0
  fi
  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" \
      "authorize dashboard ssh key for ${PCT_SSH_USER}: ${ssh_pubkey}" >&2
    return 0
  fi
  pct_authorize_ssh_key "$ssh_pubkey"
}

# Step 7 (final): hand off to the post-install self-test (#80) if it is present.
# It is a separate deliverable; until it lands the orchestrator notes it and
# completes successfully rather than failing the install.
pct_orch_self_test() {
  local self_test="${PCT_SELF_TEST:-${PCT_INSTALL_DIR}/self-test.sh}"
  pct_step "Run the post-install self-test"
  if [ -x "$self_test" ]; then
    if pct_is_dry_run; then
      printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "${self_test} ${PCT_SUPERVISED_LIST:-}" >&2
      return 0
    fi
    "$self_test"
  else
    pct_warn "self-test not installed yet (tracked as #80); skipping"
  fi
}

# --- orchestration ---------------------------------------------------------

# Run the full enrolment, given the validated server URL, token, ssh user, and
# the supervised usernames. Kept as a function so the CLI parser stays thin.
pct_install_client() {
  local server_url="$1" enrol_token="$2" ssh_user="$3"
  shift 3
  local users=("$@")

  local hostname
  hostname="$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown)"

  pct_step "Pre-flight checks"
  pct_orch_require_root
  pct_orch_require_tools
  pct_require_debian_family
  pct_orch_check_reachable "$server_url"

  # Resolve each supervised user's UID up front (fails fast on a missing user)
  # and build the flat (username uid) pair list the enrol body needs.
  local user uid pairs=()
  for user in "${users[@]}"; do
    uid="$(pct_orch_resolve_uid "$user")"
    pairs+=("$user" "$uid")
  done
  pct_ok "supervising: ${users[*]}"

  # Step: provision pct-agent.
  pct_orch_provision_agent

  # Step: install + baseline-configure the upstream tools.
  pct_step "Install + baseline-configure the upstream tools"
  pct_install_baseline_tools "${users[@]}"

  # Step: register with the dashboard.
  pct_step "Register this client with the dashboard"
  local response client_id bearer ssh_pubkey
  response="$(pct_orch_enrol "$server_url" "$enrol_token" "$hostname" "$ssh_user" "${pairs[@]}")"
  client_id="$(printf '%s' "$response" | pct_orch_json_number clientId)"
  bearer="$(printf '%s' "$response" | pct_orch_json_string bearerToken)"
  ssh_pubkey="$(printf '%s' "$response" | pct_orch_json_string sshPublicKey)"
  pct_ok "enrolled as client #${client_id:-?} (host '${hostname}', ssh user '${ssh_user}')"

  # Step: authorize the dashboard SSH key + persist the client bearer token.
  pct_orch_authorize_key "$ssh_pubkey"
  pct_orch_persist_credentials "$server_url" "$client_id" "$bearer"

  # Step: self-test.
  PCT_SUPERVISED_LIST="${users[*]}" pct_orch_self_test

  pct_ok "client enrolment complete for: ${users[*]}"
  if pct_is_dry_run; then
    pct_log "(dry-run: nothing was changed)"
  fi
}

# --- CLI -------------------------------------------------------------------

pct_orch_main() {
  local server_url="${PCT_SERVER_URL:-}"
  local enrol_token="${PCT_ENROLMENT_TOKEN:-}"
  local ssh_user="$PCT_SSH_USER"
  local users=()
  if [ -n "${PCT_SUPERVISED_USERS:-}" ]; then
    # shellcheck disable=SC2206  # intentional word-split of a space list
    users=(${PCT_SUPERVISED_USERS})
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
    --server-url)
      [ "$#" -ge 2 ] || {
        pct_err "--server-url needs a value"
        return 2
      }
      server_url="$2"
      shift 2
      ;;
    --server-url=*)
      server_url="${1#*=}"
      shift
      ;;
    --enrolment-token | --enrollment-token)
      [ "$#" -ge 2 ] || {
        pct_err "--enrolment-token needs a value"
        return 2
      }
      enrol_token="$2"
      shift 2
      ;;
    --enrolment-token=* | --enrollment-token=*)
      enrol_token="${1#*=}"
      shift
      ;;
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
    --ssh-user)
      [ "$#" -ge 2 ] || {
        pct_err "--ssh-user needs a value"
        return 2
      }
      ssh_user="$2"
      shift 2
      ;;
    --ssh-user=*)
      ssh_user="${1#*=}"
      shift
      ;;
    -h | --help)
      pct_orch_usage
      return 0
      ;;
    *)
      pct_err "unknown argument: $1"
      pct_orch_usage
      return 2
      ;;
    esac
  done

  # A real run hard-requires the server URL, a one-time token, and at least one
  # supervised user. A dry run is a side-effect-free PREVIEW: it fills clearly
  # labelled placeholders for anything missing so it can always render the full
  # plan (this is also what the minimal CI smoke test exercises — no token, no
  # user, just PCT_SERVER_URL).
  if [ -z "$server_url" ]; then
    if pct_is_dry_run; then
      server_url="https://dashboard.example"
      pct_warn "no --server-url given; using placeholder '${server_url}' for the dry-run preview"
    else
      pct_err "missing --server-url (or PCT_SERVER_URL)"
      pct_orch_usage
      return 2
    fi
  fi
  if [ -z "$enrol_token" ]; then
    if pct_is_dry_run; then
      enrol_token="DRY-RUN-PLACEHOLDER-TOKEN"
      pct_warn "no --enrolment-token given; using a placeholder for the dry-run preview"
    else
      pct_err "missing --enrolment-token (or PCT_ENROLMENT_TOKEN)"
      pct_orch_usage
      return 2
    fi
  fi
  if [ "${#users[@]}" -eq 0 ]; then
    if pct_is_dry_run; then
      users=(exampleuser)
      pct_warn "no --supervised-user given; using placeholder 'exampleuser' for the dry-run preview"
    else
      pct_err "no supervised users given (pass --supervised-user or PCT_SUPERVISED_USERS)"
      pct_orch_usage
      return 2
    fi
  fi

  pct_install_client "$server_url" "$enrol_token" "$ssh_user" "${users[@]}"
}

# Run main only when executed directly, not when sourced.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  pct_orch_main "$@"
fi
