# Plan — #360: Molecule live symlink-planting assertion for the ActivityWatch privesc fix

Follow-up to **#351** (PR #359), which fixed a child→root symlink-following
privilege escalation in `client/ansible/playbooks/activitywatch.yml`. Roadmap:
`docs/roadmap.md` → Phase 6.

## Goal

Add a **live** Molecule assertion that exercises the #351 fix at converge time,
complementing the existing **static** Vitest guard
(`server/tests/ansible/activitywatch-privesc.test.ts`, which only parses the
playbook). The static guard proves the defences are *present*; it does not prove
they actually stop a hostile symlink from being followed into a root-owned
target during a real converge. This closes that gap — and, crucially, does so
with a **positive control** so the assertion is discriminating rather than
vacuous.

## What the #351 vector actually is (and what it is not)

The escalation lives in the two `ansible.builtin.file` **`state: directory`**
tasks that create dirs inside each child's home. `file`'s `follow` defaults to
**`true`**, so a root-run directory task pointed — via a child-planted symlink
(e.g. `~/.config/systemd/user → /etc`) — at a root-owned target **follows the
link** and chowns that target to the child. The fix pins two defences on the
home-writing tasks:

1. `become_user: "{{ item }}"` — the write runs **as the child**, so a hostile
   symlink can only reach files the child already owns.
2. `follow: false` — neutralises `file`'s `follow: true` default (the root
   cause).

The **template** writes (`config.toml`, the unit files) were *never* this
vector: `ansible.builtin.template`/`copy` default `follow: false` already, so
even the pre-#351 root-run template write replaced the symlink with a regular
file rather than following it. The fix pins `follow: false` on them only as
harmless defence-in-depth. (Verified: `ansible-doc` reports
`file.follow=True`, `template.follow=False`, `copy.follow=False`.)

## Why a probe reproduction, not poisoning the real converge

A green live assertion **cannot** poison the real converge's directory tasks:
with `follow: false`, the fixed `file` task fail-closes on a symlink (no-op or
"refusing to convert between symlink and directory", depending on the Ansible
version), which reads as a **failed converge** to Molecule. And poisoning a
*template* dest proves nothing — that path behaves identically on the fixed and
vulnerable playbook (both leave the target untouched), so the assertion would be
**vacuous** (it would pass even against the un-fixed playbook).

So `verify.yml` reproduces the **exact directory-task technique** against
isolated probe symlinks under the child's home, in two steps:

- **Positive control** — the *vulnerable* shape (`file: state=directory,
  owner=child, follow: true`, run as **root**, no `become_user`). This must
  **escalate**: it chowns the root-owned `vuln-target` to the child. Asserting
  the escalation happened proves the vector is genuinely reproducible in the
  container — without it, the fixed-shape assertion could pass for the wrong
  reason.
- **The fix** — the same operation the way #351 hardened it (`become_user` +
  `follow: false`). This must leave the root-owned `fixed-target` **untouched**
  (still `uid/gid 0`, sentinel unchanged).

Asserting on **ownership of the target**, not on task success/failure, keeps the
check robust across the fix's version-dependent runtime behaviour (fail-closed
vs. harmless no-op — either way the target stays root-owned).

Empirically confirmed with `ansible-core` 2.19 (the CI line): the vulnerable
shape chowns the target to the child; the fixed shape leaves it root-owned.

This is idempotence-safe: the probes live under `~/privesc-probe` and the
canary under `/opt/pct-privesc-canary`; the real converge never touches them, so
Molecule's idempotence step is unaffected, and the assertions run once in
`verify.yml` (after converge + idempotence).

## Changes

All under `client/ansible/molecule/default/` plus one static guard.

### 1. `prepare.yml`

- As **root**: create the canary `/opt/pct-privesc-canary/{fixed-target,
  vuln-target}` (`root:root`, `0700`) and a root-owned sentinel file inside
  `fixed-target`.
- As the **child**: create `~/privesc-probe`, then plant two child-owned
  symlinks — `fixed-link → …/fixed-target` and `vuln-link → …/vuln-target`.

### 2. `verify.yml`

After the existing assertions: run the positive control, assert `vuln-target`
was chowned to the child (escalation reproduced); run the fixed shape, assert
`fixed-target` stays `uid/gid 0` and the sentinel is byte-unchanged.

### 3. `server/tests/ansible/activitywatch-molecule-privesc.test.ts`

A Vitest guard (fast gate) asserting the scenario keeps the probe planting, the
**positive control** (`follow: true`, root, asserting escalation), and the
**fixed-shape** ownership assertion — so the live check cannot silently regress
into a vacuous one.

## License boundary

N/A — test-only Ansible YAML + a Vitest guard. No dashboard code, transport,
packaging, or new dependency. Molecule stays out of the dashboard dependency
tree (pip-installed into a throwaway env, per `docs/testing.md`).

## Tamper-resistance ceiling

N/A — a regression *test* of an existing security fix (it deliberately
demonstrates the vector on a throwaway sentinel to prove the fix holds), not new
hardening. No anti-tamper hooks, kernel modules, eBPF, obfuscation, or
`/etc`/`/usr`/boot lockdown.

## Validation

- `npm run format:check && npm run lint && npm run typecheck && npm test` from
  `server/` (the static guard runs here).
- `ansible-lint client/ansible/` (fast gate on every PR).
- The `molecule` CI job (#219, gated on `client/ansible/**`) converges the
  scenario and runs `verify.yml` — the authoritative end-to-end check.
