# ADR 0014 — Dashboard privilege model on clients (`pct-agent` sudo)

- **Status:** Proposed (2026-08-23)
- **Issue:** [#345](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/345)
- **Phase:** cross-cutting; gates the client reconfigure/upgrade chain
  ([#346](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/346)
  per-command sudoers drop-in →
  [#348](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/348)
  reconcile playbook + API →
  [#349](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/349)
  admin upgrade UI), and records the push-vs-pull axis the outbound-channel
  spike ([#350](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/350))
  explores.

> **Why Proposed, not Accepted.** #345 leaned toward a "per-command sudoers"
> grant as the recommended option. On inspection that specific mechanism does
> not work for how the Phase-6 playbooks actually escalate (see Context), so
> this ADR reframes the real choice and recommends one — but leaves the final
> A-vs-B call to the maintainer, since it trades blast-radius against a
> non-trivial playbook redesign. The implementation issue (#346) is deferred
> until this is Accepted.

## Context

To push an in-place upgrade or any privileged reconfiguration from the
dashboard, the dashboard must run root-level actions on a client over its only
inbound channel: SSH as `pct-agent`, via the Ansible runner
(`server/src/transport/ansible/`). Two facts are currently in tension:

1. **The documented posture is least privilege.** `provision-agent-user.sh`
   grants `pct-agent` **NOPASSWD for `/usr/bin/timekpra` only**, and
   `docs/client-install.md` → "Tamper resistance posture" describes `pct-agent`
   as having sudo "only NOPASSWD for whitelisted commands". `CLAUDE.md` and
   `docs/client-install.md` both anticipate an "Ansible adds its own scoped
   sudoers drop-in" step that has not landed.
2. **The Phase-6 playbooks require root today and would fail.** Every playbook
   under `client/ansible/playbooks/` declares module `become: true`
   (`ansible.builtin.apt`, `systemd_service`, `template`, `copy`, `file`,
   `blockinfile`, `command`), and the runner (`transport/ansible/e2guardian.ts`,
   `apparmor.ts`) invokes them. Against the current timekpra-only sudoers, their
   escalation fails. The gap is latent only because the client-enforcement flow
   is Alpha-stage and not yet part of a live install.

### The mechanism reality that reframes the decision

Ansible module `become` does **not** run discrete binaries (`apt-get`,
`systemctl`) under sudo. It runs the *module interpreter* as root — in effect:

```
sudo -H -u root /bin/sh -c 'echo BECOME-SUCCESS-…; /usr/bin/python3 <AnsiballZ_apt>.py'
```

`ansible.cfg` sets `pipelining = True`, which streams the module over one
sudo'd shell (no staged temp file) instead of two invocations — but the sudo
**target is still an interpreter**, not a fixed command. The consequence is
decisive:

- A **NOPASSWD command-list** — `pct-agent ALL=(root) NOPASSWD: /usr/bin/apt-get,
  /usr/bin/systemctl, …` — does **not** enable module `become`, because the
  command sudo is asked to run is `/bin/sh -c '… python3 …'`.
- Whitelisting `/bin/sh` or `/usr/bin/python3` to make it work is granting
  arbitrary-code-as-root. That is not "scoped"; it is blanket root wearing a
  narrow-looking sudoers line.

So meaningful **command-level** least privilege for Ansible is not a sudoers
line at all — it requires routing every privileged action through **fixed
wrapper scripts** at pinned, root-owned paths and whitelisting only those. That
is a Phase-6 playbook redesign, not a config tweak.

### The threat model this sits in

`docs/client-install.md` is explicit: tamper resistance is "best-effort within
a supervised household context", and the **adversary is the supervised child**,
not the dashboard. The child has no sudo and cannot act as `pct-agent`
(key-only login; the private key lives only on the dashboard/server, never on
the client). Whatever privilege `pct-agent` holds is privilege the **dashboard**
holds — the trusted control plane — not privilege the child can reach.

## Decision

The real choice is between two shapes, not "blanket vs a command-list" (the
command-list is a non-option for module `become`):

- **Option A — a dedicated Ansible `become` drop-in.** Add a second sudoers
  drop-in (e.g. `/etc/sudoers.d/pct-agent-ansible`) that grants `pct-agent` the
  `become` privilege Ansible needs, kept **separate** from — and leaving
  unchanged — the timekpra-only rule. Broad by Ansible's nature, but granted to
  a system account the child cannot log into, and documented as such. Small;
  unblocks Phase 6 immediately.
- **Option B — a fixed reconcile-wrapper.** Route privileged reconfiguration
  through pinned, root-owned wrapper scripts (a small fixed set), have the
  playbooks/`command:` tasks call the wrapper without module `become`, and
  whitelist NOPASSWD for only those wrapper paths. A true command whitelist;
  larger — it reshapes how the Phase-6 playbooks apply changes — and the right
  shape once the server can no longer be treated as fully trusted.

**Recommended: Option A now; Option B documented as the tightening path.**

Rationale:

- **It does not weaken the posture against the actual adversary.** The child
  gains nothing: no sudo, no `pct-agent` login. A broad `become` for `pct-agent`
  is dashboard privilege, and the dashboard is already the trusted party in the
  household model.
- **The command-list alternative is illusory** for Ansible modules (see above),
  so "per-command sudoers" as originally sketched cannot be the answer; the
  honest options are A and B.
- **Option A is proportionate to the current stage.** It unblocks Phase 6 and
  the reconcile/upgrade chain now, with a small, testable, well-documented,
  dashboard-owned grant that is cleanly separated from the timekpra rule.
- **Option B is the answer when the trust boundary changes** — notably the
  cloud-hosted stretch ([#27](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/27)),
  where the control plane leaves the home and "the dashboard is trusted" no
  longer holds. Capturing B here means that future does not start from a broad
  grant with no plan to tighten it.

### Push vs pull (recorded, not decided here)

An alternative to the dashboard **pushing** privileged actions over SSH is a
**pull** model, like Claude Desktop's updater: the client's `pct-client-bridge`
pulls a reconcile/upgrade from the dashboard and applies it locally with its
own local privilege, sidestepping both "dashboard holds root on every client"
and the SSH-bootstrap chicken-and-egg. The trade is a privileged local updater
on the client, with its own security review. This ADR records the axis and
keeps push (Ansible over SSH) as the model for the reconfigure/upgrade work;
the pull option is the subject of spike #350. Whichever wins, this ADR's
A-vs-B question still applies to the privilege the applying principal holds.

### This is config management, not anti-circumvention

Granting `pct-agent` the privilege to apply admin-authored configuration is
**admin-initiated config management** within the documented bounded
tamper-resistance / household posture. It is **not** anti-circumvention
hardening: it adds no anti-tamper hooks, no obfuscation, no lockdown of
`/etc`/`/usr`/boot, and no attempt to make the system harder for a determined
root user to defeat (`CLAUDE.md` → "Tamper resistance is deliberately
bounded"). The supervised user's privilege is unchanged (still no sudo).

## Consequences

- **#346 implements Option A** (once Accepted): a dedicated, `visudo`-validated,
  atomically-installed `pct-agent-ansible` drop-in provisioned by
  `provision-agent-user.sh` alongside — and without touching — the existing
  timekpra-only drop-in; idempotent; bats-covered. `docs/client-install.md`
  documents the exact grant and why it is broad. If the maintainer prefers
  Option B, #346 is re-scoped to the wrapper set and the Phase-6 tasks that
  call them.
- The dashboard/server becomes a root-capable controller for enrolled clients
  via `pct-agent`. The mitigation is operational and already assumed by the
  design: the SSH key is server-held and never on the client, `pct-agent` is
  key-only, and the supervised user has no path to it. Hardening `sshd_config`
  further remains deliberately out of scope (`docs/client-install.md`).
- No license-boundary impact: `timekpra` and Ansible stay subprocesses; no GPL
  linkage or image-bundled GPL binaries are introduced (`CLAUDE.md` → "License
  boundaries"). This ADR concerns only the sudo surface of the SSH principal.
- **Verification is deferred to a live gate.** A real sudoers + Ansible-`become`
  round-trip needs an actual client and cannot run in the scheduled-run sandbox;
  it is verified separately under the #157-style live round-trip, following the
  precedent set by [ADR 0009](0009-adguard-managed-supervisor.md) (managed
  AdGuard Home verified against the real binary separately).

## References

- `client/lib/provision-agent-user.sh` (the existing timekpra-only drop-in).
- `client/ansible/playbooks/*.yml`, `client/ansible/ansible.cfg`
  (`pipelining = True`), `server/src/transport/ansible/`.
- `docs/client-install.md` → "Tamper resistance posture"; `CLAUDE.md` →
  "Tamper resistance is deliberately bounded", "License boundaries".
- Builds on PR #341 (enabled sshd) and #344 (re-runnable installer via
  `--skip-enrol`). Gates #346 / #348 / #349; records the axis for #350.
- [ADR 0009](0009-adguard-managed-supervisor.md) — precedent for
  deferring a live round-trip to a separate gate.
