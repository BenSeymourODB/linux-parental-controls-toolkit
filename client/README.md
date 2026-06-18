# Client

Client-side install scripts and templates for enrolling a supervised
Linux desktop (initial target: **Linux Mint with Cinnamon**, Ubuntu/Debian
family). This tree is filling in as the Phase 3 install components land; the
top-level `install-client.sh` orchestrator (#76) and the remaining steps
(`agent/`, `ansible/`) are still to come, and the `shellcheck`, `ansible-lint`,
`client-tests`, and `client-install-dryrun` CI jobs scan these paths.

The authoritative design lives in
[`docs/client-install.md`](../docs/client-install.md). Read that first; the
summary below maps the directory layout to it.

## What enforcement uses

The client does **not** reimplement screen-time or web-filtering logic. It
installs and configures existing open-source tools, and adds a small
notification/UX agent on top:

- **Session limits** — Timekpr-nExT (driven remotely by the dashboard via
  `timekpra` over SSH).
- **Activity tracking** — ActivityWatch (`aw-server`, `aw-watcher-window`,
  `aw-watcher-afk`, plus the browser extension).
- **Web filtering** — e2guardian with per-UID filter groups and an iptables
  OUTPUT-chain redirect to its proxy port.

## Planned contents

### `install-client.sh` (Phase 3)

One command turns a fresh Mint machine into a managed client: sanity checks,
repository setup, package install, baseline configuration of Timekpr-nExT /
ActivityWatch / e2guardian, creation of the low-privilege `pct-agent`
orchestration user with scoped `sudoers`, registration with the dashboard,
and an end-of-run self-test. The script is idempotent (re-running reconciles
rather than re-bootstraps). See
[`docs/client-install.md`](../docs/client-install.md) → "What the script
does".

GPL components (Timekpr-nExT, e2guardian, ActivityWatch) come from the
distribution's package manager or upstream releases — **not** from this
repository — preserving the license boundary documented in
[`docs/licensing-analysis.md`](../docs/licensing-analysis.md).

The orchestrator is being built bottom-up from its sub-steps: each is a
sourceable, idempotent, dry-run-aware module that `install-client.sh` (#76)
will call (set `PCT_DRY_RUN=1` to print the intended plan without changing
anything). Shell modules are unit-tested with
[bats](https://github.com/bats-core/bats-core) under `tests/`
(`bats client/tests/`) and linted with `shellcheck`; both run in CI.

- `lib/pct-common.sh` — shared helpers (logging, a dry-run-aware command
  runner, `/etc/os-release` distro detection, file writing), sourced by the
  install components.
- `lib/provision-agent-user.sh` (#78) — creates the low-privilege `pct-agent`
  service account and its narrowly-scoped `sudoers` rule (the SSH principal the
  dashboard connects as).
- `install-baseline-tools.sh` (#79) — installs and writes a **safe baseline**
  config for the three upstream tools: adds the Timekpr-nExT PPA, installs
  `timekpr-next` / `e2guardian`, fetches the pinned ActivityWatch upstream
  release (checksum-verified, binding `aw-server` to `127.0.0.1:5600` only),
  and lays down per-supervised-user ActivityWatch `systemd --user` units plus
  a permissive e2guardian baseline + per-UID filter-group skeleton. The
  *managed* configuration — real e2guardian filter rules, the iptables OUTPUT
  redirect, ActivityWatch upgrades, AppArmor — is owned by the Phase 6 Ansible
  playbooks (`ansible/`); this step deliberately stops at the baseline (no
  iptables here).

Run a component standalone, or dry-run it (no root/network needed):

```bash
sudo bash client/install-baseline-tools.sh --supervised-user alice
PCT_DRY_RUN=1 bash client/install-baseline-tools.sh --supervised-user alice
```

### `agent/` (Phase 8b)

The `pct-client` agent (TypeScript), shipped as a `.deb` that bundles its
own Node runtime so it does not depend on the distro's Node packages:

- `pct-client-bridge` — system-level service holding the WebSocket to the
  dashboard's `/api/events/stream` and dispatching events to per-user
  agents.
- `pct-client-agent` — per-supervised-user `systemd --user` service that
  renders toast notifications and sounds, computes the time-remaining
  cadence locally, and performs per-app force-close.

The agent adds notifications and a graceful end-of-budget experience around
Timekpr-nExT's session enforcement; it does not replace it. See
[`docs/client-notifications.md`](../docs/client-notifications.md).

### `ansible/` (Phase 6)

Playbooks invoked by the dashboard (as a subprocess, over SSH) to push
e2guardian filter groups, iptables OUTPUT redirects, ActivityWatch
`systemd --user` units, and AppArmor profiles, and to periodically re-apply
them (tamper reversion). The dashboard never links Ansible in-process — it
runs `ansible-playbook` from an isolated venv in its data volume.

### `distros/` (Phase 3+)

Per-distribution adapters sourced by `install-client.sh` based on the
detected OS (`/etc/os-release`), e.g. `distros/<id>.sh`. Linux Mint is the
initial target and is covered by the main `apt`-based path; Fedora /
openSUSE / Arch adapters are lower-priority follow-ups documented in
[`docs/client-install.md`](../docs/client-install.md) → "Other
distributions".

## Tamper resistance is deliberately bounded

The hardening posture in
[`docs/client-install.md`](../docs/client-install.md) → "Tamper resistance
posture" is the **ceiling**, not a starting point. This tree will not grow
anti-tamper hooks, kernel modules, eBPF probes, binary/config obfuscation,
or `/etc`/`/usr`/boot lockdown. The product assumes a household context
(parent admin, child user); a user skilled enough to defeat the documented
protections has outgrown the product.
