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
# shellcheck source=client/lib/pct-dispatch.sh
. "${PCT_BASELINE_DIR}/lib/pct-dispatch.sh"

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

# timekpr-next now ships in the Debian/Ubuntu repositories, so by default we
# install it straight from the distro (a plain `apt-get install timekpr-next`,
# no external repository). The upstream PPA is kept as an opt-in fallback for
# older releases that predate the packaged version — set PCT_TIMEKPR_USE_PPA=1
# to add it. We avoid the PPA by default because its add-apt-repository path has
# proven flaky (the Launchpad lookup's fixed ~10s timeout fails on slow links).
PCT_TIMEKPR_USE_PPA="${PCT_TIMEKPR_USE_PPA:-0}"

# Timekpr-nExT upstream PPA (Ubuntu/Mint), used only when PCT_TIMEKPR_USE_PPA=1.
# We add it ourselves rather than via `add-apt-repository`, whose Launchpad
# lookup has a ~10s timeout hardcoded in software-properties (no flag, no env
# var) — too short for a slow link. Doing the two fetches (signing-key
# fingerprint + key) with curl lets us set the timeout ourselves
# (PCT_PPA_FETCH_TIMEOUT), pins trust to that key, and drops the
# software-properties dependency for this step.
TIMEKPR_PPA="${TIMEKPR_PPA:-ppa:mjasnik/ppa}"
TIMEKPR_PPA_OWNER="${TIMEKPR_PPA_OWNER:-mjasnik}"
TIMEKPR_PPA_NAME="${TIMEKPR_PPA_NAME:-ppa}"
# Where the PPA publishes packages, and its Launchpad API record (queried for
# the signing-key fingerprint). Overridable wholesale for tests / mirrors.
TIMEKPR_PPA_URI="${TIMEKPR_PPA_URI:-https://ppa.launchpadcontent.net/${TIMEKPR_PPA_OWNER}/${TIMEKPR_PPA_NAME}/ubuntu}"
TIMEKPR_PPA_LP_API="${TIMEKPR_PPA_LP_API:-https://api.launchpad.net/devel/~${TIMEKPR_PPA_OWNER}/+archive/ubuntu/${TIMEKPR_PPA_NAME}}"
# Keyserver the signing key is fetched from, by fingerprint.
PCT_KEYSERVER_URL="${PCT_KEYSERVER_URL:-https://keyserver.ubuntu.com/pks/lookup}"
# Optionally pin the fingerprint to skip the Launchpad API entirely (most robust
# on a flaky link).
TIMEKPR_PPA_FINGERPRINT="${TIMEKPR_PPA_FINGERPRINT:-}"
# Apt suite (the Ubuntu series the PPA is built for). Defaults to the host's
# Ubuntu base codename (Mint reports it in UBUNTU_CODENAME, e.g. jammy);
# overridable.
TIMEKPR_PPA_SUITE="${TIMEKPR_PPA_SUITE:-}"
# The apt source + (armoured) keyring we write. Modern apt accepts an armoured
# key in Signed-By when the file ends .asc, so no gpg/dearmor step is needed.
TIMEKPR_PPA_KEYRING="${TIMEKPR_PPA_KEYRING:-/etc/apt/keyrings/timekpr-next-ppa.asc}"
TIMEKPR_PPA_SOURCES="${TIMEKPR_PPA_SOURCES:-/etc/apt/sources.list.d/timekpr-next-ppa.sources}"
# Per-fetch network timeout (seconds) for the Launchpad/keyserver curls — the
# whole point of adding the PPA ourselves: a value we control, unlike
# add-apt-repository's fixed ~10s. Raise it on a slow link.
PCT_PPA_FETCH_TIMEOUT="${PCT_PPA_FETCH_TIMEOUT:-60}"
# Idempotency: presence of our sources file — or a legacy add-apt-repository
# `*mjasnik*.list` from an earlier install — means the repo is already
# configured. Overridable so tests can point it at a fixture.
TIMEKPR_PPA_LIST_GLOB="${TIMEKPR_PPA_LIST_GLOB:-/etc/apt/sources.list.d/*mjasnik*.list}"

# Timekpr-nExT's own config + client-indicator autostart (#268). In Alpha-1 the
# richer pct-client-agent cadence/grace UX (Phase 8b) is not shipped, so
# Timekpr-nExT's native client indicator is the ONLY warning a supervised user
# gets before a session cutoff. We tune its warning lead times to be generous
# and ensure its indicator autostarts for each supervised user. All paths +
# values are overridable on the established PCT_* pattern so the tests can
# exercise this without root or the package installed.
PCT_TIMEKPR_CONF="${PCT_TIMEKPR_CONF:-/etc/timekpr/timekpr.conf}"
# Seconds before a cutoff for the single "time's almost up" heads-up
# (upstream default 60). Generous Alpha-1 value: 5 minutes of warning.
# Invariant: keep this >= the final-warning countdown below — the heads-up
# fires first, then the continuous countdown runs through to the cutoff. If you
# override one, override the other so the ordering holds.
PCT_TIMEKPR_FINAL_NOTIFICATION_TIME="${PCT_TIMEKPR_FINAL_NOTIFICATION_TIME:-300}"
# Seconds of continuous final countdown before a cutoff (upstream default 10).
# Generous Alpha-1 value: the whole final minute counts down.
PCT_TIMEKPR_FINAL_WARNING_TIME="${PCT_TIMEKPR_FINAL_WARNING_TIME:-60}"
# The package's system-wide client-indicator autostart entry, and the per-user
# filename we drop into ~/.config/autostart to guarantee + force-enable it.
PCT_TIMEKPR_AUTOSTART_SRC="${PCT_TIMEKPR_AUTOSTART_SRC:-/etc/xdg/autostart/timekpr-client.desktop}"
PCT_TIMEKPR_CLIENT_DESKTOP="${PCT_TIMEKPR_CLIENT_DESKTOP:-timekpr-client.desktop}"

# Where the per-supervised-user e2guardian baseline skeletons live. A
# pct-namespaced directory so we never disturb a household's existing
# e2guardian config; Phase 6 Ansible reads these as the seed for the real
# per-UID filter groups.
E2G_DIR="${E2G_DIR:-/etc/e2guardian}"
E2G_PCT_DIR="${E2G_PCT_DIR:-${E2G_DIR}/pct.d}"

# --- step: apt repositories ------------------------------------------------

# Resolve the Ubuntu series (apt "Suite") the PPA is consumed for. Mint reports
# its Ubuntu base in UBUNTU_CODENAME (e.g. jammy); plain Ubuntu uses
# VERSION_CODENAME. Honours the TIMEKPR_PPA_SUITE override. Echoes the suite (or
# the empty string if it can't be determined).
pct_baseline_ppa_suite() {
  if [ -n "$TIMEKPR_PPA_SUITE" ]; then
    printf '%s' "$TIMEKPR_PPA_SUITE"
    return 0
  fi
  local os_release="${PCT_OS_RELEASE:-/etc/os-release}" line ubuntu="" version=""
  if [ -r "$os_release" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
      UBUNTU_CODENAME=*) ubuntu="${line#*=}" ;;
      VERSION_CODENAME=*) version="${line#*=}" ;;
      esac
    done <"$os_release"
  fi
  local suite="${ubuntu:-$version}"
  suite="${suite%\"}"
  suite="${suite#\"}"
  printf '%s' "$suite"
}

# Echo the PPA signing-key fingerprint: the pinned value if given, else fetched
# from the Launchpad API with our own (configurable) timeout. Non-zero + empty
# on failure.
pct_baseline_ppa_fingerprint() {
  if [ -n "$TIMEKPR_PPA_FINGERPRINT" ]; then
    printf '%s' "$TIMEKPR_PPA_FINGERPRINT"
    return 0
  fi
  local json
  json="$(pct_retry curl --fail --silent --show-error \
    --max-time "$PCT_PPA_FETCH_TIMEOUT" "$TIMEKPR_PPA_LP_API")" || return 1
  # The LP API record carries "signing_key_fingerprint": "<40 hex>".
  if [[ "$json" =~ \"signing_key_fingerprint\"[[:space:]]*:[[:space:]]*\"([0-9A-Fa-f]+)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

# Add the Timekpr-nExT PPA without add-apt-repository: resolve the signing key
# and write an apt source pinned to it, with every network fetch bounded by a
# timeout we control (PCT_PPA_FETCH_TIMEOUT) rather than the fixed ~10s baked
# into software-properties' Launchpad lookup.
pct_baseline_add_timekpr_ppa() {
  local suite
  suite="$(pct_baseline_ppa_suite)"
  pct_log "Adding Timekpr-nExT PPA ${TIMEKPR_PPA} (suite ${suite:-unknown}, fetch timeout ${PCT_PPA_FETCH_TIMEOUT}s)"

  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" \
      "resolve signing key (curl --max-time ${PCT_PPA_FETCH_TIMEOUT} ${TIMEKPR_PPA_LP_API} + ${PCT_KEYSERVER_URL})" >&2
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "write ${TIMEKPR_PPA_KEYRING}" >&2
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" \
      "write ${TIMEKPR_PPA_SOURCES} (deb ${TIMEKPR_PPA_URI} ${suite:-<suite>} main)" >&2
    return 0
  fi

  if [ -z "$suite" ]; then
    pct_err "could not determine the Ubuntu series for the PPA; set TIMEKPR_PPA_SUITE (e.g. jammy)"
    return 1
  fi

  local fpr
  if ! fpr="$(pct_baseline_ppa_fingerprint)" || [ -z "$fpr" ]; then
    pct_err "could not resolve the Timekpr-nExT PPA signing key from ${TIMEKPR_PPA_LP_API} (slow/unreachable Launchpad?); raise PCT_PPA_FETCH_TIMEOUT, or pin TIMEKPR_PPA_FINGERPRINT"
    return 1
  fi

  # Fetch the ASCII-armoured signing key by fingerprint, with our own timeout.
  mkdir -p "$(dirname "$TIMEKPR_PPA_KEYRING")"
  if ! pct_retry curl --fail --silent --show-error --max-time "$PCT_PPA_FETCH_TIMEOUT" \
    --output "$TIMEKPR_PPA_KEYRING" \
    "${PCT_KEYSERVER_URL}?op=get&options=mr&search=0x${fpr}"; then
    pct_err "failed to fetch the PPA signing key 0x${fpr} from ${PCT_KEYSERVER_URL}"
    return 1
  fi
  chmod 0644 "$TIMEKPR_PPA_KEYRING"

  # Write a deb822 source pinned (Signed-By) to the key we just fetched.
  pct_write_file "$TIMEKPR_PPA_SOURCES" <<EOF
Types: deb
URIs: ${TIMEKPR_PPA_URI}
Suites: ${suite}
Components: main
Signed-By: ${TIMEKPR_PPA_KEYRING}
EOF
  pct_ok "Timekpr-nExT PPA configured (${TIMEKPR_PPA_SOURCES})"
}

pct_baseline_add_repositories() {
  pct_step "Add upstream package repositories"
  # timekpr-next: default to the distribution's own repositories (no external
  # repo). The PPA is opt-in for older releases that don't carry the package.
  if ! pct_is_true "$PCT_TIMEKPR_USE_PPA"; then
    pct_ok "Installing timekpr-next from the distribution repositories (no PPA); set PCT_TIMEKPR_USE_PPA=1 to add ${TIMEKPR_PPA} on a release that lacks it"
  elif compgen -G "$TIMEKPR_PPA_LIST_GLOB" >/dev/null 2>&1 || [ -f "$TIMEKPR_PPA_SOURCES" ]; then
    pct_ok "Timekpr-nExT PPA already present"
  else
    pct_baseline_add_timekpr_ppa
  fi
  pct_retry apt-get update -q
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
  # Network-dependent (downloads packages from the mirrors); retry on a
  # transient fetch failure rather than aborting the enrolment.
  pct_retry env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${want[@]}"
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
  # Network-dependent: retry the GitHub release download on a transient failure.
  pct_retry curl --fail --location --silent --show-error --output "$zip_path" "$url"

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
  pct_step "Configure Timekpr-nExT (baseline: daemon + generous Alpha-1 warnings)"
  # Initial policy is intentionally empty — the dashboard pushes limits via
  # `timekpra` over SSH after enrolment. We only ensure the daemon is up and
  # the CLI the server drives is on PATH.
  pct_run systemctl enable --now timekpr.service

  # Give supervised users plenty of advance warning before a session cutoff.
  # Alpha-1 has no pct-client-agent cadence/grace UX (Phase 8b), so this is the
  # only warning the user gets. Edit just these keys in place — the rest of the
  # upstream config (session types, excluded users, polltime, …) is preserved.
  pct_set_conf_key "$PCT_TIMEKPR_CONF" \
    TIMEKPR_FINAL_NOTIFICATION_TIME "$PCT_TIMEKPR_FINAL_NOTIFICATION_TIME"
  pct_set_conf_key "$PCT_TIMEKPR_CONF" \
    TIMEKPR_FINAL_WARNING_TIME "$PCT_TIMEKPR_FINAL_WARNING_TIME"

  if pct_is_dry_run; then
    printf '%s %s\n' "$PCT_DRYRUN_PREFIX" "command -v timekpra" >&2
  elif command -v timekpra >/dev/null 2>&1; then
    pct_ok "timekpra present at $(command -v timekpra)"
  else
    pct_warn "timekpra not found on PATH; the dashboard's SSH transport needs it (check the timekpr-next install)"
  fi
}

# --- step: Timekpr-nExT client indicator autostart (per supervised user) ----

# Copy the package's client-indicator autostart entry to `dest`, forcing it
# enabled (stripping any Hidden / X-GNOME-Autostart-enabled lines and appending
# the enabled forms). Factored out so it is unit-testable without resolving a
# real user's home. Copying the package's own .desktop keeps its `Exec` correct
# across upgrades; the force-enable defends against a stale per-user override.
pct_timekpr_write_user_autostart() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  {
    grep -viE '^[[:space:]]*(Hidden|X-GNOME-Autostart-enabled)[[:space:]]*=' "$src" || true
    printf 'Hidden=false\nX-GNOME-Autostart-enabled=true\n'
  } >"$dest"
}

pct_baseline_configure_timekpr_client() {
  pct_step "Enable the Timekpr-nExT client indicator autostart (per supervised user)"
  local user home dest
  for user in "$@"; do
    if ! pct_is_dry_run && ! getent passwd "$user" >/dev/null 2>&1; then
      pct_warn "supervised user '${user}' does not exist; skipping client-indicator autostart"
      continue
    fi
    home="$(getent passwd "$user" | cut -d: -f6 || true)"
    [ -n "$home" ] || home="/home/${user}"
    dest="${home}/.config/autostart/${PCT_TIMEKPR_CLIENT_DESKTOP}"
    pct_log "Timekpr-nExT client indicator autostart for ${user}"

    if pct_is_dry_run; then
      printf '%s enable timekpr client indicator autostart for %s -> %s (from %s)\n' \
        "$PCT_DRYRUN_PREFIX" "$user" "$dest" "$PCT_TIMEKPR_AUTOSTART_SRC" >&2
      continue
    fi

    if [ ! -r "$PCT_TIMEKPR_AUTOSTART_SRC" ]; then
      pct_warn "no system autostart entry ${PCT_TIMEKPR_AUTOSTART_SRC}; is timekpr-next installed? the time-left indicator may not appear for ${user}"
      continue
    fi
    pct_timekpr_write_user_autostart "$PCT_TIMEKPR_AUTOSTART_SRC" "$dest"
    pct_chown_user "$user" "${home}/.config/autostart"
  done
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
  pct_require_supported_client
  pct_baseline_add_repositories
  pct_baseline_install_packages
  pct_baseline_install_activitywatch
  pct_baseline_configure_timekpr
  pct_baseline_configure_activitywatch "$@"
  pct_baseline_configure_timekpr_client "$@"
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
