# Issue #91 — Playbook: ActivityWatch systemd-user units deploy/upgrade

Roadmap: Phase 6 ("ActivityWatch systemd-user units").
Issue: https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/91

## Goal

The first Phase-6 Ansible playbook: deploy **and upgrade** ActivityWatch
(`aw-server` + `aw-watcher-window` + `aw-watcher-afk`) as `systemd --user`
units across supervised users, keeping the telemetry stack server-managed
rather than hand-installed. It owns the *managed* lifecycle on top of the
Phase-3 baseline laid down by `client/install-baseline-tools.sh` (#79) — whose
unit files already carry the comment "Phase 6 Ansible (#91) owns upgrades and
any changes beyond this baseline."

## What the baseline (#79) already does — mirror it exactly

- Pins `AW_VERSION=v0.13.2`, `AW_SHA256=8f62b10b…`, `AW_PREFIX=/opt/activitywatch`,
  `AW_HOST=127.0.0.1`, `AW_PORT=5600`.
- Downloads `activitywatch-${AW_VERSION}-linux-x86_64.zip` from the upstream
  GitHub release, checksum-verifies, extracts under `/opt/activitywatch`,
  records `/opt/activitywatch/.pct-aw-version`.
- Writes `~/.config/activitywatch/aw-server-rust/config.toml` (loopback only).
- Writes `~/.config/systemd/user/{aw-server,aw-watcher-afk,aw-watcher-window}.service`.
- `loginctl enable-linger`, `systemctl --user enable`.

## Scope of this playbook (managed lifecycle, beyond baseline)

1. **Deploy/upgrade** the AW bundle to a target version: download +
   checksum-verify + extract, idempotent via the version stamp; on a version
   *change*, restart the per-user units so the upgrade takes effect.
2. **Drift reconciliation:** re-render `config.toml` (loopback-only binding)
   and the three unit files on every run, so a local edit is reverted on the
   next re-apply (ties into the Phase-6 periodic re-apply scheduler #93).
3. Ensure linger + `daemon-reload` + units enabled (and started where a user
   session/`XDG_RUNTIME_DIR` is available).
4. Per supervised user, driven by an `aw_supervised_users` list (the runner
   passes it via `--extra-vars`; `transport/ansible` already supports JSON
   extra-vars).

## Non-goals / deferred

- Image→`/data/ansible/playbooks` sync + venv bootstrap is the first-run
  entrypoint step (#39, Phase 6) — NOT this PR. This PR ships the playbook
  source under `client/ansible/` (the documented location: CLAUDE.md layout,
  the `ansible-lint` CI job, `docs/testing.md` Molecule section).
- The browser extension (manual; baseline leaves a note).
- e2guardian/iptables (#90) and AppArmor (#92) playbooks.

## License boundary

ActivityWatch is MPL-2.0 (not GPL). Ansible (GPL-3.0) is only ever **exec'd**
as a subprocess by the runner. The playbook fetches the AW release bundle onto
the **client** (like `apt`), never into the dashboard image. No GPL/MPL binary
enters the dashboard image; no in-process linkage. (CLAUDE.md → License
boundaries; `docs/licensing-analysis.md`.)

## Layout

```
client/ansible/
  ansible.cfg                       # roles/inventory defaults for local runs + molecule
  .ansible-lint                     # profile + any justified skips
  README.md                         # what lives here, how to lint/molecule
  playbooks/
    activitywatch.yml               # entry point the runner invokes by name
    templates/
      aw-server-config.toml.j2
      aw-unit.service.j2
  molecule/
    default/
      molecule.yml                  # docker driver (Debian/Ubuntu)
      converge.yml
      verify.yml
```

A **self-contained playbook** (not a role): the `transport/ansible` runner
runs `<ansibleDir>/playbooks/<name>` and the #39 sync copies `playbooks/`, so
templates live in `playbooks/templates/` to travel with it. `template:`
resolves them relative to the playbook directory.

## Tests

- **`ansible-lint`** over `client/ansible/` — the CI gate (`ci.yml`). Must pass
  the chosen profile. Run locally.
- **`ansible-playbook --syntax-check`** locally.
- **Molecule** scenario at `client/ansible/molecule/default/` (Docker driver) —
  the authoritative integration test per `docs/testing.md`. Authored here;
  cannot be *run* in the scheduled-run sandbox (no Docker daemon, same
  constraint noted in #207). Converge applies the playbook; verify asserts the
  bundle, config.toml loopback binding, and the three unit files are present
  and enabled.

## Phases

1. Foundation: `client/ansible/` skeleton (`ansible.cfg`, `.ansible-lint`,
   `README.md`) + the playbook + templates. Lint + syntax-check green.
2. Molecule scenario (converge + verify). Lint green over the whole tree.
3. Docs: note the playbook in `client/README.md` / `docs/architecture.md`
   where the AW deployment row lives; PR body documents the license note and
   the deferred #39 packaging step.
