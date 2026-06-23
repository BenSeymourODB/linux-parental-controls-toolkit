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
  apparmor-profiles.yml      # #92 — per-app hard-deny AppArmor profiles
  e2guardian-filtering.yml   # #90 — per-UID web filter + iptables OUTPUT redirect
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

### `apparmor-profiles.yml` (#92)

Drops AppArmor profiles that hard-block designated executables for the
supervised users on a client — the AppArmor half of `docs/architecture.md` →
"Per-app deny (hard block)" (the e2guardian web-filter half is #90). An empty
profile in enforce mode grants the executable no permissions, so it cannot
read/map its libraries and fails to start. Profiles are written under
`/etc/apparmor.d/pct.d/`, loaded via `apparmor_parser`, and **reconciled** every
run so a lifted deny removes its profile (the periodic re-apply scheduler, #93).

The dashboard's `transport/ansible/apparmor.ts` builds the plan from policy and
passes it whole as the `apparmor_plan` `--extra-vars` object:

| Variable        | Default          | Purpose                                               |
| --------------- | ---------------- | ----------------------------------------------------- |
| `apparmor_plan` | `{"denials": []}` | The per-client plan: `denials[].{profileName,executable,blockedFor}` |

AppArmor attaches per *executable*, not per Linux UID, so a profile blocks the
binary client-wide; per-user attribution lives in the dashboard audit log, and
true per-UID exec gating is a follow-up. In-scope per-app **blocking**
enforcement only — it does not lock down `/etc`, `/usr`, or boot media against
root (`CLAUDE.md` → "Tamper resistance is deliberately bounded").

> **Live convergence test deferred.** AppArmor enforcement inside a container
> needs a privileged, AppArmor-capable host; the Molecule scenario applying this
> playbook against a real client is a tracked follow-up (mirroring the #90/#215
> split for e2guardian). `ansible-lint` (production profile) and YAML/Jinja
> parse cover it structurally today.

### `e2guardian-filtering.yml` (#90)

Renders one managed e2guardian filter group per supervised user and the
**paired** iptables OUTPUT redirect that sends each user's `:80`/`:443` traffic
to that user's e2guardian listen port — the e2guardian half of
`docs/architecture.md` → "Per-website filter | e2guardian | Ansible-deployed
config". The filter is inert without the redirect, so the two deploy together.
Per-user banned-site lists + group config land under `/etc/e2guardian/pct.d/`
(the namespace the Phase-3 baseline reserved); group 1 stays the permissive
baseline.

The dashboard's `transport/ansible/e2guardian.ts` builds the plan from policy
(the always-on `deny` schedules targeting `domain` activities) and passes it
whole as the `e2guardian` `--extra-vars` object:

| Variable     | Default | Purpose                                                                                              |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `e2guardian` | _(req)_ | `{proxyPort, redirectPorts[], users[].{osUsername,osUserRef,filterGroup,listenPort,bannedSites[]}}` |

> **Filtering is not yet live end-to-end.** The playbook renders the per-group
> config + banned-site lists and installs the per-UID iptables redirect, but the
> e2guardian directive set that actually *selects* a filter group by listen port
> (the `filtergroups` count + the port→group auth-plugin binding) is **not yet
> in place** — so redirected traffic is still filtered by the permissive group 1
> until that lands. Completing that binding and proving live filtering is the
> Molecule follow-up (#215); this PR `Addresses #90` rather than closing it.
> `ansible-lint` (production profile) + YAML/Jinja parse cover the rendering
> structurally today.

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
  the loopback-only config, and the rendered units. The e2guardian
  filter/redirect convergence (#215) extends this scenario.
