# Plan — #360: Molecule live symlink-planting assertion for the ActivityWatch privesc fix

Follow-up to **#351** (PR #359), which fixed a child→root symlink-following
privilege escalation in `client/ansible/playbooks/activitywatch.yml`. Roadmap:
`docs/roadmap.md` → Phase 6.

## Goal

Add a **live** Molecule assertion that exercises the #351 fix at converge time,
complementing the existing **static** Vitest guard
(`server/tests/ansible/activitywatch-privesc.test.ts`, which only parses the
playbook). The static guard proves the two defences are *present* on the
home-writing tasks; it does not prove Ansible actually refuses to follow a
hostile symlink into a root-owned target during a real converge. This closes
that gap end-to-end.

The fix pins two defences on every task that writes into a supervised (child)
user's home:

1. `become_user: "{{ item }}"` (or `"{{ item.0 }}"`) — the write runs **as the
   child**, so a hostile symlink can only ever reach files the child already
   owns.
2. `follow: false` — neutralises `ansible.builtin.file`/`template`'s
   `follow: yes` symlink-following default (the documented root cause).

## Key design constraint — why the leaf-file (template) vector, not the directory vector

The issue's illustrative example plants `~/.config/systemd/user → /etc` (a
symlink at a `state: directory` path) and asserts `/etc` stays root-owned.
Planting a symlink at one of the two `state: directory` paths does **not** work
against the *fixed* playbook in the standard Molecule sequence:

- With `follow: false` + `state: directory`, Ansible's `file` module **errors**
  with "refusing to convert between symlink and directory" when the path is an
  existing symlink. That is the fix behaving correctly (fail-closed, no chown),
  but Molecule interprets a failed converge as a **failed test** — so a live
  green assertion of a task deliberately engineered to fail-closed is not
  expressible in the default `create → prepare → converge → idempotence →
  verify` sequence.

So the live assertion targets the **template (leaf-file) dests** instead
(`config.toml` and an `aw-server.service` unit file). Under the fixed playbook:

- `become_user: alice` runs the template write **as alice**, and
- `follow: false` makes the atomic write **replace the symlink** with a regular
  file in alice's own tree rather than following it into the root-owned canary.

The converge therefore stays **green** while still exercising *both* defences on
a real symlink. The `state: directory` chown vector remains covered by the
static guard (which asserts `become_user` + `follow: false` on all four
home-writing tasks, directories included).

This is idempotence-safe: the first converge replaces each poisoned symlink with
a real file (a change); the second converge (Molecule's idempotence step) sees
identical rendered content and reports no change.

## Changes

All under `client/ansible/molecule/default/` (the existing ActivityWatch
scenario) plus one static guard mirroring the repo's existing pattern.

### 1. `prepare.yml`

- As **root**: create a root-owned canary tree `/opt/pct-privesc-canary/` with
  two sentinel files (`config-canary`, `unit-canary`), `root:root`, mode `0600`,
  each holding a known marker string.
- As **alice** (`become_user: alice`): create the two parent config dirs that
  the converge will manage (`~/.config/activitywatch/aw-server-rust`,
  `~/.config/systemd/user`) as real, alice-owned directories, then plant two
  hostile **leaf symlinks** pointing at the root-owned canaries:
  - `~/.config/activitywatch/aw-server-rust/config.toml → /opt/pct-privesc-canary/config-canary`
  - `~/.config/systemd/user/aw-server.service → /opt/pct-privesc-canary/unit-canary`

### 2. `verify.yml`

Add assertions (after the existing ones) that the escalation did **not** occur:

- Each canary file is still owned by `root:root` (`stat.pw_name == 'root'`,
  `stat.gr_name == 'root'`).
- Each canary file's content is **unchanged** (still the sentinel marker — not a
  rendered aw-server config / systemd unit).
- alice's `config.toml` and `aw-server.service` are now **regular files** (not
  symlinks) owned by `alice` — i.e. the write landed locally in alice's home.

Under the vulnerable pre-#351 playbook (root-run + `follow: yes`) these would
fail: the canary would be rewritten (and possibly chowned to alice). Under the
fix they pass.

### 3. `server/tests/ansible/activitywatch-molecule-privesc.test.ts` (static guard)

A Vitest guard mirroring `activitywatch-privesc.test.ts`: parse `prepare.yml`
and `verify.yml` and assert the canary planting + the root-ownership /
content-unchanged assertions are present, so the live assertion cannot silently
regress if someone edits the scenario. This runs in the fast `npm test` gate
(Molecule itself only runs in the `client/ansible/**`-gated integration job).

## License boundary

N/A — test-only Ansible YAML + a Vitest guard. No dashboard code, no transport,
no packaging, no new dependency. Molecule stays out of the dashboard dependency
tree (installed with `pip` into a throwaway env, per `docs/testing.md`).

## Tamper-resistance ceiling

N/A — this is a regression *test* of an existing security fix, not new
hardening. It adds no anti-tamper hooks, kernel modules, eBPF, obfuscation, or
`/etc`/`/usr`/boot lockdown.

## Validation

- `npm run format:check && npm run lint && npm run typecheck && npm test` from
  `server/` (the static guard runs here).
- `ansible-lint client/ansible/` (fast gate on every PR).
- The `molecule` CI job (#219, gated on `client/ansible/**`) converges the
  scenario and runs `verify.yml` — the authoritative end-to-end check.
