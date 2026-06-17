# Plan — #79 Client: install + baseline-configure Timekpr-nExT, ActivityWatch, e2guardian

Roadmap: `docs/roadmap.md` → Phase 3 (client install). One of the install
sub-steps the orchestrator `client/install-client.sh` (#76) will compose.
Sibling of #78 (`pct-agent` user + sudoers) — **disjoint scope**: this issue
only lays the three upstream tools down and writes a *safe baseline*.

## Authoritative sources

- `docs/client-install.md` → "What the script does" steps 2–6, 9, and the
  "Tamper resistance posture" ceiling.
- `docs/architecture.md` → transport table (aw-server is `localhost:5600`,
  pulled over an SSH tunnel — never network-exposed).
- `docs/licensing-analysis.md` → GPL tools come from the distro / upstream,
  never bundled in this repo or the server image. We only ever talk to
  ActivityWatch over its REST API.
- `scripts/start-aw-server.sh` + `.claude/plans/issue-20-*.md` → the pinned
  ActivityWatch upstream-release approach (version + SHA-256). Reused here
  for the client install so the repo pins one AW version.

## Hard boundaries for this issue

- **Baseline only.** The *managed* config — real e2guardian filter rules,
  the iptables OUTPUT redirect, AW upgrades, AppArmor — is owned by the
  Phase 6 Ansible playbooks (#90/#91/#92). This script gets the tools
  present and minimally working so the self-test (#80) passes, and leaves
  documented extension points. **No iptables here.**
- **No tamper-resistance scope creep** (CLAUDE.md ceiling). Least-privilege
  baseline, nothing that "makes it harder to circumvent".
- **License boundary.** `apt`/upstream-release installs only; nothing GPL is
  vendored into the repo; aw-server is reached over REST only.

## Layout

- `client/lib/pct-common.sh` — small sourceable helper library shared by the
  client scripts: structured, non-punitive logging (`pct_log/ok/warn/err/
  step`), a dry-run-aware command runner (`pct_run`, gated on
  `PCT_DRY_RUN=1`), `pct_is_dry_run`, `/etc/os-release` distro detection
  (`pct_detect_distro` → `PCT_OS_ID`/`PCT_OS_ID_LIKE`, `pct_require_debian_
  family`), and a dry-run-aware file writer (`pct_write_file`). This is the
  natural foundation for every `client/*.sh`; if #78 introduces an
  equivalent, whichever lands first wins and the other rebases.
- `client/install-baseline-tools.sh` — the #79 deliverable. Sourceable
  functions plus a `main` guard so it runs standalone (and under
  `PCT_DRY_RUN=1` in CI without root/network):
  - `pct_baseline_add_repositories` — Timekpr-nExT PPA `ppa:mjasnik/ppa`
    (idempotent: skip if the list file already exists). ActivityWatch is an
    upstream release bundle, not an apt repo; e2guardian is in the distro.
  - `pct_baseline_install_packages` — `apt-get install` `timekpr-next`,
    `e2guardian`, and the fetch deps (`curl`, `unzip`). Idempotent via
    `dpkg-query` checks.
  - `pct_baseline_install_activitywatch` — download the pinned upstream
    `activitywatch-${AW_VERSION}-linux-x86_64.zip`, SHA-256 verify, extract
    to `/opt/activitywatch` (skip if already that version). aw-server bound
    to `127.0.0.1:5600` only.
  - `pct_baseline_configure_timekpr` — enable + start `timekpr.service`;
    confirm `timekpra` on PATH. Empty initial policy (server pushes later).
  - `pct_baseline_configure_activitywatch <user...>` — per supervised user:
    install `aw-server`/`aw-watcher-window`/`aw-watcher-afk` `systemd --user`
    units (into `~/.config/systemd/user`), write the aw-server localhost
    config, `loginctl enable-linger`, enable the units, and drop the
    browser-extension instructions file on the Desktop.
  - `pct_baseline_configure_e2guardian <user...>` — set `/etc/default/
    e2guardian` to run, write a clearly-marked **permissive** baseline
    filter group + a per-supervised-user group skeleton under
    `/etc/e2guardian/`, enable the service. **No iptables** (Phase 6).
  - `pct_install_baseline_tools <user...>` — orchestrates the above in order.

## ActivityWatch pin

Reuse `AW_VERSION=v0.13.2` / its SHA-256 from `scripts/start-aw-server.sh`,
both env-overridable. Single pinned version across the repo.

## Tests (bats)

No bats harness exists yet; add one scoped to the client scripts and a CI
`shell-tests` job that installs bats and runs `client/tests/*.bats`.

- `client/tests/pct-common.bats` — logging routes to stderr; `pct_run`
  prints-not-executes under dry-run and executes otherwise; distro detection
  parses a fixture `os-release`; `pct_require_debian_family` accepts
  ubuntu/linuxmint/debian and rejects fedora; `pct_write_file` reports intent
  under dry-run and writes (creating parent dirs) otherwise.
- `client/tests/install-baseline-tools.bats` — under `PCT_DRY_RUN=1` the
  emitted plan: adds the Timekpr PPA, installs the three tools, binds
  aw-server to `127.0.0.1:5600`, iterates every supervised user for AW + the
  e2guardian skeleton, enables `timekpr.service`/`e2guardian`, and contains
  **no `iptables`** call. Idempotency branches: PPA file present → skipped;
  `/opt/activitywatch` already at the pinned version → no re-download.

## Quality gate

shellcheck clean (`client/**/*.sh`, pre-commit + CI), bats green, and the TS
gate untouched (no `server/` changes). Update `client/README.md` to point at
the new component and note the Phase-6 extension points.

## Deferred (tracked)

- iptables OUTPUT redirect + real e2guardian rules + AW upgrades + AppArmor →
  Phase 6 Ansible (#90/#91/#92), already filed.
- The end-to-end exercise of these scripts on a real Mint box runs through
  the orchestrator #76 + self-test #80.
