# Client Ansible playbooks

The Phase-6 Ansible playbooks the **dashboard** runs against enrolled clients
over SSH. They own the *managed* lifecycle of the client-side tools — the
ongoing deploy/upgrade/reconcile that the one-shot Phase-3 install scripts
(`client/install-baseline-tools.sh`, #79) deliberately stop short of.

## How they run in production

The dashboard never links Ansible in-process. Its `transport/ansible` runner
(`server/src/transport/ansible/`) execs `ansible-playbook` from an isolated
venv in the data volume and points it at `<PCT_ANSIBLE_DIR>/playbooks/<name>`
(default `/data/ansible/playbooks/`), with a dynamic inventory built from the
`Client` records and the supervised users passed as `--extra-vars`. This is the
structural GPL license boundary — see `CLAUDE.md` → "License boundaries" and
`docs/licensing-analysis.md`.

> **Packaging note.** Getting these playbooks from this directory into the
> image's read-only copy (and synced to `/data/ansible/playbooks/` on first
> run) is the entrypoint bootstrap step tracked in #39 — it is intentionally
> not wired yet. The playbooks here are authored against the runner's contract
> (`playbooks/<name>` + `playbooks/templates/`) so they drop in unchanged once
> that sync lands.

## Layout

```
playbooks/
  activitywatch.yml          # #91 — deploy/upgrade AW as systemd --user units
  templates/                 # Jinja templates, resolved relative to the playbook
molecule/
  default/                   # Molecule scenario (docker driver)
```

Templates live under `playbooks/templates/` (not a separate role) so they
travel with the `playbooks/` sync and `template:` resolves them relative to the
playbook directory.

## Playbooks

### `activitywatch.yml` (#91)

Deploys and upgrades ActivityWatch (`aw-server` + `aw-watcher-window` +
`aw-watcher-afk`) as per-user `systemd --user` units, binding `aw-server` to
loopback only. Idempotent via an on-disk version stamp; re-rendered config and
units mean a local edit is reverted on the next re-apply (the periodic
re-apply scheduler, #93). The version pin, prefix and unit shapes mirror
`client/install-baseline-tools.sh` so the baseline and the managed playbook
never disagree.

Variables of note (override via `--extra-vars`):

| Variable              | Default            | Purpose                                  |
| --------------------- | ------------------ | ---------------------------------------- |
| `aw_supervised_users` | `[]`               | Linux usernames to manage on the host    |
| `aw_version`          | `v0.13.2`          | ActivityWatch release to deploy/upgrade  |
| `aw_sha256`           | _(pinned)_         | Bundle checksum, verified before extract |
| `aw_prefix`           | `/opt/activitywatch` | Install root                           |
| `aw_host` / `aw_port` | `127.0.0.1` / `5600` | Loopback-only aw-server binding        |

## Tests

- **`ansible-lint`** runs over this directory in CI (`.github/workflows/ci.yml`
  → `ansible-lint` job). Run it locally with `ansible-lint client/ansible/`.
- **Molecule** is the authoritative integration test (`docs/testing.md` →
  "Ansible playbooks — Molecule"). It needs a Docker daemon:

  ```bash
  pip install molecule molecule-plugins[docker]
  cd client/ansible && molecule test
  ```

  The scenario stands up a systemd-enabled Debian/Ubuntu container, creates
  supervised test users, applies `activitywatch.yml`, and verifies the bundle,
  the loopback-only config, and the rendered units.
