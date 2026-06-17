#!/usr/bin/env bash
#
# install-baseline-tools.sh — install + baseline-configure the three upstream
# enforcement/telemetry tools on a supervised Linux client (Phase 3, #79):
#
#   - Timekpr-nExT   (session limits; driven later by the dashboard via
#                     `timekpra` over SSH)
#   - ActivityWatch  (activity telemetry; pulled later over an SSH tunnel)
#   - e2guardian     (web filtering; real rules managed later by Ansible)
#
# This lays the tools down and writes a *safe baseline* only — enough that the
# post-install self-test (#80) passes. The managed configuration (real
# e2guardian filter rules, the iptables OUTPUT redirect, ActivityWatch
# upgrades, AppArmor) is owned by the Phase 6 Ansible playbooks (#90/#91/#92);
# this script deliberately stops at the baseline and leaves those as
# documented extension points. There is **no iptables work here**.
#
# License boundary (docs/licensing-analysis.md): the GPL tools are installed
# from the distribution's package manager and the projects' own upstream
# releases — never vendored into this repository or bundled into the dashboard
# image. ActivityWatch is only ever reached over its REST API.
#
# Tamper-resistance posture (docs/client-install.md): this is a least-
# privilege baseline, not lockdown. Nothing here exists to "make circumvention
# harder".
#
# The script is idempotent (re-running reconciles) and dry-run aware: set
# PCT_DRY_RUN=1 to print the intended plan without touching the system — that
# is how CI and the bats tests exercise it without root, network, or the
# tools installed.
#
# Sourceable: the orchestrator (client/install-client.sh, #76) sources this
# and calls pct_install_baseline_tools. Run directly for a standalone install:
#
#   sudo bash client/install-baseline-tools.sh --supervised-user alice
#   PCT_DRY_RUN=1 bash client/install-baseline-tools.sh --supervised-user alice

set -euo pipefail

# Resolve our own directory so we can source the shared helpers whether run
# directly or sourced from the orchestrator.
PCT_BASELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=client/lib/pct-common.sh
. "${PCT_BASELINE_DIR}/lib/pct-common.sh"

# --- pinned upstream artifacts ---------------------------------------------
#
# ActivityWatch publishes a prebuilt release bundle (no apt package). Pin the
# version + SHA-256 so the artifact is reproducible and under our control;
# kept in step with scripts/start-aw-server.sh so the repo pins one AW
# version. Both overridable via the environment.
AW_VERSION="${AW_VERSION:-v0.13.2}"
AW_SHA256="${AW_SHA256:-8f62b10babf8a8f108cbdf7267c02fbc1ce2a970fa9535f230b3416b803e3360}"
AW_PREFIX="${AW_PREFIX:-/opt/activitywatch}"
AW_HOST="${AW_HOST:-127.0.0.1}"
AW_PORT="${AW_PORT:-5600}"

# Timekpr-nExT upstream PPA (Debian/Ubuntu/Mint).
TIMEKPR_PPA="${TIMEKPR_PPA:-ppa:mjasnik/ppa}"
# Glob matching the apt list file `add-apt-repository` writes for that PPA (its
# exact name embeds the distro codename). Presence makes the "add repository"
# step idempotent; overridable so tests can point it at a fixture.
TIMEKPR_PPA_LIST_GLOB="${TIMEKPR_PPA_LIST_GLOB:-/etc/apt/sources.list.d/*mjasnik*.list}"

# Where the per-supervised-user e2guardian baseline skeletons live. A
# pct-namespaced directory so we never disturb a household's existing
# e2guardian config; Phase 6 Ansible reads these as the seed for the real
# per-UID filter groups.
E2G_DIR="${E2G_DIR:-/etc/e2guardian}"
E2G_PCT_DIR="${E2G_PCT_DIR:-${E2G_DIR}/pct.d}"

# --- step: apt repositories ------------------------------------------------

pct_baseline_add_repositories() {
  pct_step "Add upstream package repositories"
  if compgen -G "$TIMEKPR_PPA_LIST_GLOB" >/dev/null 2>&1; then
    pct_ok "Timekpr-nExT PPA already present (${TIMEKPR_PPA_LIST_GLOB})"
  else
    pct_log "Adding Timekpr-nExT PPA ${TIMEKPR_PPA}"
    pct_run add-apt-repository -y "$TIMEKPR_PPA"
  fi
  pct_run apt-get update -q
  # ActivityWatch is an upstream release bundle (handled below); e2guardian
  # ships in the distro repositories — no extra repo needed for either.
}

# --- step: distro packages -------------------------------------------------

# True if a .deb package is already installed.
pct_pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"
}

pct_baseline_install_packages() {
  pct_step "Install distro packages"
  # timekpr-next + e2guardian are the enforcement tools; curl/unzip are needed
  # to fetch + extract the ActivityWatch bundle.
  local pkg want=()
  for pkg in timekpr-next e2guardian curl unzip; do
    if pct_pkg_installed "$pkg"; then
      pct_ok "${pkg} already installed"
    else
      want+=("$pkg")
    fi
  done
  if [ "${#want[@]}" -eq 0 ]; then
    pct_ok "all distro packages already present"
    return 0
  fi
  pct_log "Installing: ${want[*]}"
  pct_run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${want[@]}"
}

# --- step: ActivityWatch upstream bundle -----------------------------------

pct_baseline_install_activitywatch() {
  pct_step "Install ActivityWatch ${AW_VERSION} (upstream release bundle)"
  local stamp="${AW_PREFIX}/.pct-aw-version"
  if [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$AW_VERSION" ]; then
    pct_ok "ActivityWatch ${AW_VERSION} already installed at ${AW_PREFIX}"
    return 0
  fi

  # The pinned upstream bundle is x86_64-only; fail loudly rather than 404 on a
  # mismatched arch (an ARM Mint/RPi client is out of scope for this baseline).
  local arch
  arch="$(uname -m 2>/dev/null || echo unknown)"
  if [ "$arch" != "x86_64" ]; then
    pct_err "ActivityWatch baseline supports x86_64 only (this host is '${arch}')"
    return 1
  fi

  local archive="activitywatch-${AW_VERSION}-linux-x86_64.zip"
  local url="https://github.com/ActivityWatch/activitywatch/releases/download/${AW_VERSION}/${archive}"
  local tmp="${PCT_AW_CACHE:-/tmp/pct-aw}"
  local zip_path="${tmp}/${archive}"

  pct_run mkdir -p "$tmp" "$AW_PREFIX"
  pct_log "Downloading ${url}"
  pct_run curl --fail --location --silent --show-error --output "$zip_path" "$url"

  # Verify the checksum before extracting anything we downloaded.
  pct_log "Verifying SHA-256"
  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "echo ${AW_SHA256}  ${zip_path} | sha256sum --check --status" >&2
  else
    echo "${AW_SHA256}  ${zip_path}" | sha256sum --check --status
  fi

  pct_log "Extracting to ${AW_PREFIX}"
  pct_run unzip -q -o "$zip_path" -d "$AW_PREFIX"

  # Record the installed version so re-runs are a no-op.
  printf '%s\n' "$AW_VERSION" | pct_write_file "$stamp"
  pct_ok "ActivityWatch ${AW_VERSION} installed"
}

# --- step: Timekpr-nExT ----------------------------------------------------

pct_baseline_configure_timekpr() {
  pct_step "Configure Timekpr-nExT (baseline: enable daemon, empty policy)"
  # Initial policy is intentionally empty — the dashboard pushes limits via
  # `timekpra` over SSH after enrolment. We only ensure the daemon is up and
  # the CLI the server drives is on PATH.
  pct_run systemctl enable --now timekpr.service
  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "command -v timekpra" >&2
  elif command -v timekpra >/dev/null 2>&1; then
    pct_ok "timekpra present at $(command -v timekpra)"
  else
    pct_warn "timekpra not found on PATH; the dashboard's SSH transport needs it (check the timekpr-next install)"
  fi
}

# --- step: ActivityWatch per-user systemd --user units ---------------------

# Write the aw-server config that binds it to loopback only. The dashboard
# pulls telemetry over an SSH tunnel; aw-server is never network-exposed
# (docs/architecture.md).
pct_aw_server_config() {
  local home="$1"
  printf '# Managed by pct install-baseline-tools.sh — loopback-only baseline.\n[server]\nhost = "%s"\nport = %s\n' \
    "$AW_HOST" "$AW_PORT" |
    pct_write_file "${home}/.config/activitywatch/aw-server-rust/config.toml"
}

# Write one `systemd --user` unit for a supervised user.
pct_aw_unit() {
  local home="$1" name="$2" exec_path="$3" desc="$4"
  pct_write_file "${home}/.config/systemd/user/${name}.service" <<EOF
# Managed by pct install-baseline-tools.sh — ActivityWatch ${AW_VERSION} baseline.
# Phase 6 Ansible (#91) owns upgrades and any changes beyond this baseline.
[Unit]
Description=${desc}
After=network.target

[Service]
ExecStart=${exec_path}
Restart=on-failure

[Install]
WantedBy=default.target
EOF
}

pct_baseline_configure_activitywatch() {
  pct_step "Configure ActivityWatch systemd --user units (per supervised user)"
  local user home
  for user in "$@"; do
    if ! pct_is_dry_run && ! getent passwd "$user" >/dev/null 2>&1; then
      pct_warn "supervised user '${user}' does not exist; skipping ActivityWatch setup"
      continue
    fi
    pct_log "ActivityWatch units for ${user}"
    home="$(getent passwd "$user" | cut -d: -f6 || true)"
    [ -n "$home" ] || home="/home/${user}"
    local uid
    uid="$(id -u "$user" 2>/dev/null || true)"

    # aw-server bound to loopback only.
    pct_aw_server_config "$home"

    pct_aw_unit "$home" "aw-server" \
      "${AW_PREFIX}/activitywatch/aw-server-rust/aw-server-rust --host ${AW_HOST} --port ${AW_PORT}" \
      "ActivityWatch server (loopback only)"
    pct_aw_unit "$home" "aw-watcher-afk" \
      "${AW_PREFIX}/activitywatch/aw-watcher-afk/aw-watcher-afk" \
      "ActivityWatch AFK watcher"
    pct_aw_unit "$home" "aw-watcher-window" \
      "${AW_PREFIX}/activitywatch/aw-watcher-window/aw-watcher-window" \
      "ActivityWatch window watcher"

    # The browser extension can't be installed unattended; leave a note.
    pct_write_file "${home}/Desktop/install-aw-browser-extension.md" <<'EOF'
# Install the ActivityWatch browser extension

ActivityWatch tracks application/window time automatically, but accurate
*per-site* time needs the browser extension. Install it for your browser:

- Firefox:  https://addons.mozilla.org/firefox/addon/aw-watcher-web/
- Chrome/Chromium/Edge:  https://chromewebstore.google.com/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi

It talks only to your local ActivityWatch server (127.0.0.1:5600) — nothing
leaves this machine until the dashboard pulls it over a secure tunnel.
EOF

    # We wrote those files as root; hand them back to the user so aw-server
    # (and `systemctl --user`) can read/write its own config + DB.
    pct_chown_user "$user" "${home}/.config"
    pct_chown_user "$user" "${home}/Desktop/install-aw-browser-extension.md"

    # Linger so the user manager runs without an active login; then enable the
    # units. They start on the user's next graphical login (aw-watcher-window /
    # -afk need a desktop session anyway), or immediately once that session is
    # up — `enable` here just makes them persistent.
    pct_run loginctl enable-linger "$user"
    local svc
    for svc in aw-server aw-watcher-afk aw-watcher-window; do
      pct_run sudo -u "$user" XDG_RUNTIME_DIR="/run/user/${uid}" \
        systemctl --user enable "${svc}.service"
    done
  done
}

# --- step: e2guardian baseline ---------------------------------------------

# Write the permissive default filter group: high naughtiness limit + no block
# lists, so installing e2guardian never silently breaks browsing before the
# admin pushes real rules. Factored out so its content is unit-testable.
pct_e2g_baseline_filtergroup() {
  pct_write_file "${E2G_DIR}/e2guardianf1.conf" <<'EOF'
# Managed by pct install-baseline-tools.sh — PERMISSIVE Phase 3 baseline.
#
# This is intentionally allow-all so the tool can be installed without
# blocking the supervised user before the admin pushes real rules. The
# managed per-UID filter groups + iptables OUTPUT redirect are owned by the
# Phase 6 Ansible playbooks (#90); do not hand-edit beyond the baseline.
groupmode = 1
naughtynesslimit = 9999
reportinglevel = 0
EOF
}

pct_baseline_configure_e2guardian() {
  pct_step "Configure e2guardian (permissive baseline + per-user skeleton)"
  # Let the service run (some Debian packagings ship it gated off). Real filter
  # rules + the iptables OUTPUT redirect are Phase 6 Ansible's job (#90); this
  # baseline must NOT block traffic.
  printf '# Managed by pct install-baseline-tools.sh (Phase 3 baseline).\nRUN=yes\n' |
    pct_write_file "/etc/default/e2guardian"

  pct_e2g_baseline_filtergroup

  # Per-supervised-user skeleton placeholders, namespaced under pct.d so a
  # household's existing e2guardian config is left untouched. Phase 6 reads
  # these as the seed for the real per-UID filter groups.
  local user
  for user in "$@"; do
    local uid
    uid="$(id -u "$user" 2>/dev/null || echo "")"
    pct_write_file "${E2G_PCT_DIR}/${user}.filtergroup" <<EOF
# Skeleton baseline for supervised user '${user}' (uid=${uid:-unknown}).
# Phase 6 Ansible (#90) expands this into the managed per-UID filter group and
# wires the iptables OUTPUT redirect. Baseline is intentionally empty/allow.
EOF
  done

  pct_run systemctl enable --now e2guardian.service
}

# --- orchestration ---------------------------------------------------------

pct_install_baseline_tools() {
  # Args: the supervised Linux usernames to configure.
  if [ "$#" -eq 0 ]; then
    pct_err "no supervised users given; pass at least one --supervised-user"
    return 2
  fi
  pct_require_debian_family
  pct_baseline_add_repositories
  pct_baseline_install_packages
  pct_baseline_install_activitywatch
  pct_baseline_configure_timekpr
  pct_baseline_configure_activitywatch "$@"
  pct_baseline_configure_e2guardian "$@"
  pct_ok "baseline tool install complete for: $*"
  if pct_is_dry_run; then
    pct_log "(dry-run: nothing was changed)"
  fi
}

# --- CLI -------------------------------------------------------------------

pct_baseline_usage() {
  cat >&2 <<'EOF'
Usage: install-baseline-tools.sh --supervised-user USER [--supervised-user USER ...]

Installs and baseline-configures Timekpr-nExT, ActivityWatch, and e2guardian
on a Debian/Ubuntu/Mint client. Run as root (or via sudo) for a real install.

Options:
  --supervised-user USER   A Linux account to supervise (repeatable). May also
                           be supplied via PCT_SUPERVISED_USERS (space list).
  -h, --help               Show this help.

Environment:
  PCT_DRY_RUN=1            Print the plan without changing anything.
EOF
}

pct_baseline_main() {
  local users=()
  # Seed from the environment list if present.
  if [ -n "${PCT_SUPERVISED_USERS:-}" ]; then
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
      pct_baseline_usage
      return 0
      ;;
    *)
      pct_err "unknown argument: $1"
      pct_baseline_usage
      return 2
      ;;
    esac
  done
  if [ "${#users[@]}" -eq 0 ]; then
    pct_err "no supervised users given"
    pct_baseline_usage
    return 2
  fi
  pct_install_baseline_tools "${users[@]}"
}

# Run main only when executed directly, not when sourced by the orchestrator.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  pct_baseline_main "$@"
fi
