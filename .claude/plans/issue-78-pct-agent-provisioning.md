# Issue #78 — pct-agent service-user provisioning + scoped sudoers

Phase 3. Standalone, idempotent client-side step that creates the
low-privilege `pct-agent` service account and its **narrowly scoped**
NOPASSWD sudoers rule. `pct-agent` is the SSH principal the dashboard
connects as (Phase 4 transport) and the user the Phase 8b
`pct-client-bridge` runs as.

Authoritative spec: `docs/client-install.md` → "What the script does" step 7
and "Tamper resistance posture".

## Design decisions

- **Where:** `client/lib/provision-agent-user.sh` — a *sourceable* module
  (the Phase-3 orchestrator `install-client.sh` #76 will `source` it and call
  `pct_provision_agent_user`) that is also directly runnable for standalone
  use and testing. Built bottom-up because #76 is blocked behind the
  enrolment endpoint (#77 → #52/#51).
- **User:** `useradd --system --create-home --shell /bin/bash pct-agent`.
  Idempotent via `getent passwd`.
- **Sudoers (least privilege):** a single drop-in
  `/etc/sudoers.d/pct-agent`, mode `0440`, granting **only**
  `pct-agent ALL=(root) NOPASSWD: /usr/bin/timekpra` — the one binary the
  Phase 4 transport and the Phase 8b bridge (`timekpra --kill-session`) drive.
  Validated with `visudo -cf` before install; installed atomically.
  - **Ansible-applied privileged actions (Phase 6) are deliberately NOT
    granted here.** Those playbooks (#90 e2guardian/iptables, #92 AppArmor)
    add their own scoped drop-in when they land. Pre-granting broad root now
    would violate the bounded tamper-resistance posture. Documented extension
    point in the script + a follow-up note on the Phase-6 issues.
- **SSH key:** optional `--ssh-key <file>` / `--ssh-key-string <str>` installs
  the dashboard's public key into `~pct-agent/.ssh/authorized_keys`
  (0700/0600, deduped). When no key is supplied the step skips it — the
  orchestrator (#76) fetches the key via the one-time enrolment token (#77)
  and passes it in, keeping #78 decoupled from #77.

## License / tamper boundaries

- No GPL code or binaries added; `timekpr-next` is installed from `apt` by a
  separate step (#79). This step only references the `timekpra` path in a
  sudoers rule. `license-guard` unaffected.
- Least-privilege only — no lockdown, no anti-tamper. Matches the ceiling in
  `docs/client-install.md`.

## Tests

- `client/tests/provision-agent-user.bats` (bats-core): user-create happy path
  + idempotency, sudoers content + `0440` mode + idempotency, visudo-failure
  aborts without installing, ssh-key authorize + dedupe. PATH-stubs for
  `getent`/`useradd`/`chown`/`visudo` so the real branching logic runs
  unprivileged.
- New `client-tests` CI job (installs `bats`, runs `client/tests`), mirroring
  the existing `shellcheck` / `ansible-lint` job guards.
- `shellcheck` (existing job + pre-commit) covers the script itself.

## Out of scope (deferred, tracked elsewhere)

- Phase-6 Ansible sudoers entries → #90 / #92.
- Wiring this step into the orchestrator → #76 (blocked on #77).
- Installing the upstream tools themselves → #79.
