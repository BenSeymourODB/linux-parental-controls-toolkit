# Plan — #351: symlink-following privesc (child → root) in `activitywatch.yml`

## Problem

`client/ansible/playbooks/activitywatch.yml` runs `hosts: all`, `become: true`
(as root). Its "Reconcile per-user ActivityWatch configuration and units" block
creates directories and renders templates **inside each supervised user's home**
(`{{ ansible_facts.getent_passwd[item][4] }}/.config/...`). The child owns that
home, so it is fully writable by them.

`ansible.builtin.file`'s `follow` parameter **defaults to `yes`**. For
`state: directory`, when the leaf path is a symlink the module resolves it
(`realpath`) and applies `owner`/`group`/`mode` to the **target**. A child who
replaces `~/.config/systemd/user` with a symlink to `/etc` gets `/etc` chowned to
themselves on the next root-run re-apply (Phase-6 periodic re-apply, #93) — a
concrete unprivileged → root escalation.

In scope per `CLAUDE.md`: this is a genuine privesc defect in our own code, not a
tamper-*evasion* arms-race feature.

## Affected tasks (the per-user block, lines ~140–178)

1. `file` `state: directory` → `.config/activitywatch/aw-server-rust` (loop: `aw_supervised_users`, item = user)
2. `file` `state: directory` → `.config/systemd/user` (loop: `aw_supervised_users`, item = user)
3. `template` → `.config/activitywatch/aw-server-rust/config.toml` (loop: `aw_supervised_users`, item = user)
4. `template` → `.config/systemd/user/{{ item.1.name }}.service` (loop: `product(...)`, item.0 = user)

## Fix (combine the issue's option 1 + option 2)

- **`become_user: "{{ item }}"`** (or `"{{ item.0 }}"` for task 4) on all four
  tasks — the robust fix: root never touches a child-owned path, so a hostile
  symlink can only ever reach files the child already owns (no escalation).
  Mirrors the play's own later `systemd_service` tasks (already `become_user`).
- **`follow: false`** on all four — directly neutralises the documented
  `follow: yes` root cause and documents intent.
- `owner`/`group` (set to the same user) stay: harmless no-ops when running as
  that user, and they keep intent explicit.
- Add a comment block above the block referencing #351.

## Sibling playbooks — audited, no change

`e2guardian-filtering.yml` and `apparmor-profiles.yml` write only into root-owned
`/etc` trees (`pct_e2g_dir`, `pct_e2g_managed_dir`, `pct_apparmor_dir`, all
`owner: root`). The supervised user cannot plant a symlink there, so the vector
does not exist. Note this in the PR.

## Tests

- New Vitest guard `server/tests/ansible/activitywatch-privesc.test.ts`: parse the
  playbook YAML (`yaml` dep, already present) and assert every home-writing
  `ansible.builtin.file`/`ansible.builtin.template` task (path/dest references
  `getent_passwd`) carries `become_user` resolving to the loop user **and**
  `follow: false`. Regression guard so the vector cannot silently reopen. Mirrors
  the static-analysis approach of `dockerfile-playbooks.test.ts`.
- Live Molecule symlink-planting assertion (plant `~/.config/systemd/user →
  /etc`, converge, assert `/etc` still root-owned) belongs to the Molecule
  harness (#242); note as fast-follow, do not stand up live infra in this PR.

## License boundary

N/A — no transport/packaging change; Ansible stays a subprocess, nothing linked.

## Quality gate

`cd server && npm run format && npm run lint:fix && npm run typecheck && npm test`.
