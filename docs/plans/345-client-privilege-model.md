# Plan — #345: ADR for the dashboard's client privilege model

- **Issue:** [#345](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/345)
- **Type:** decision / ADR (docs only). Gates #346 (per-command sudoers
  drop-in), #348 (reconcile playbook + API), #349 (admin upgrade UI), and
  interacts with #350 (outbound pull-model spike).
- **Branch:** `claude/compassionate-tesla-m2g8hm`

## Goal

Decide — on purpose — how much privilege the dashboard's SSH principal
(`pct-agent`) carries on a supervised client, and record it as an ADR so the
downstream reconfigure/upgrade work has a settled contract. Acceptance
(from the issue): an ADR under `docs/adr/` + a note in
`docs/client-install.md` "Tamper resistance posture".

## Key finding that shapes the decision

The Phase-6 playbooks (`client/ansible/playbooks/{e2guardian-filtering,
apparmor-profiles,activitywatch}.yml`) all escalate with Ansible **module**
`become: true` (`ansible.builtin.apt`, `systemd_service`, `template`, `copy`,
`file`, `blockinfile`, `command`). `client/ansible/ansible.cfg` sets
`pipelining = True`.

Ansible module `become` does **not** invoke discrete binaries like
`apt-get`/`systemctl` under sudo. It runs the *module interpreter* as root —
effectively `sudo -u root /bin/sh -c '… python3 <AnsiballZ_module>.py'`
(pipelining streams the module over one sudo'd shell rather than staging a temp
file, but the sudo target is still an interpreter, not a fixed command). So:

- Today `pct-agent`'s sudoers grants **NOPASSWD `/usr/bin/timekpra` only**
  (`client/lib/provision-agent-user.sh`). Every Phase-6 playbook would **fail
  to escalate** against that — a real, latent gap (the enforcement transports
  invoke these playbooks; the flow is Alpha-stage / not yet in a live install).
- A **NOPASSWD command-list** (`apt-get`, `systemctl`, specific files) — the
  mechanism #346 sketches — cannot let Ansible modules escalate, because the
  actual sudo target is `/bin/sh -c '… python3 …'`. Whitelisting that is
  arbitrary-code-as-root — i.e. not meaningfully scoped at all.

Meaningful *command-level* least privilege therefore requires routing every
privileged action through **fixed wrapper scripts** at pinned paths and
whitelisting only those — a Phase-6 playbook redesign, not a sudoers line.

## Options for the ADR

- **A — dedicated Ansible `become` drop-in.** A second, separate sudoers
  drop-in grants `pct-agent` the broad `become` Ansible needs, kept apart from
  the timekpra-only rule and clearly documented. Broad by Ansible's nature, but
  granted to a **system account the supervised child cannot log into**, whose
  private key lives only on the server. Small, unblocks Phase 6 now.
- **B — fixed reconcile-wrapper.** Privileged reconfiguration is funnelled
  through pinned wrapper scripts; `pct-agent` gets NOPASSWD for only those.
  True whitelist; larger redesign; the right shape if the server ever leaves
  the home (cloud-hosted stretch #27) and can no longer be treated as trusted.

## Recommendation

**Option A now, Option B documented as the tightening path.** Rationale:
the tamper-resistance threat model (`docs/client-install.md`) names the
**supervised child** as the adversary, not the dashboard. The child has no
sudo and cannot become `pct-agent` (key-only, server-held key), so a broad
`become` grant to `pct-agent` does not weaken the posture *against the child*.
The residual "dashboard key = root on clients" concern is bounded by the
household trust model (the dashboard is the trusted control plane) and is the
concern that Option B addresses if/when that trust boundary changes. Record the
push-vs-pull axis (Claude-Desktop-style client-pull) and defer it to the #350
spike.

Because this refines the issue's initial "per-command (recommended)" lean, the
ADR ships **Status: Proposed** as a **draft PR** for the maintainer to confirm
A vs B; `#346` implementation is deferred until then.

## Deliverables

1. `docs/adr/0014-client-privilege-model.md` (Status: Proposed).
2. `docs/client-install.md` "Tamper resistance posture" — a note reflecting the
   proposed decision and cross-linking the ADR.
3. This plan doc.

## Out of scope (deferred, tracked)

- Implementing the sudoers drop-in / wrapper — #346, gated on the A-vs-B call.
- The reconcile playbook + API (#348), admin UI (#349), pull-model spike (#350).
- Any live sudoers / Ansible-become round-trip — needs a real client; verified
  under the #157-style live gate, per the ADR 0009 precedent.

## Validation

Docs-only change: no server/frontend code touched. Run Prettier over the
changed Markdown; the repo gate's `format:check` covers `.md`. No `tsc`/test
surface.
