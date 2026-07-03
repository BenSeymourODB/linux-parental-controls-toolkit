# Plan — #219 CI: run the Ansible Molecule scenarios in a workflow

Roadmap: `docs/roadmap.md` → Phase 6 (Ansible config push). Issue #219.

## Goal

Gate the Ansible **Molecule** integration tests (`client/ansible/molecule/`) in
CI, so a playbook that lints clean but fails to *converge* is caught
automatically rather than only on the maintainer's machine. Today CI runs only
static `ansible-lint`; `molecule test` is documented as a local-only step
(`docs/testing.md` → "Ansible playbooks — Molecule").

## Decisions (the issue asks me to make these)

1. **Where.** Add a `molecule` job to `.github/workflows/integration.yml`
   (the live-service integration workflow), *not* the fast `ci.yml`. This
   mirrors the issue's recommendation and sits alongside the other
   container-converging jobs (activitywatch / adguard / ssh-transport).

2. **Trigger / cost.** Converging systemd containers is expensive.
   `integration.yml` already fires on `pull_request` → main, a nightly
   `schedule`, and `workflow_dispatch`. The molecule job:
   - always runs on `schedule` and `workflow_dispatch`;
   - on a `pull_request`, only runs when `client/ansible/**` changed (a
     per-job `git diff` gate that sets a `run` output, exactly the
     "check-prereqs → gate steps with `if:`" idiom the sibling jobs already
     use — no new third-party action).

3. **Runner / privilege.** GitHub-hosted `ubuntu-22.04` (cgroup v2, Docker
   pre-installed). The existing `molecule.yml` already declares the
   geerlingguy systemd image with `privileged: true`, `cgroupns_mode: host`
   and the `/sys/fs/cgroup` mount — the canonical GH-Actions molecule recipe.
   No runner-side privilege tweaks needed; molecule drives the local daemon.

4. **Install surface.** `pip install molecule molecule-plugins[docker]
   ansible-core` into the runner's throwaway env — never the dashboard
   dependency tree (`docs/testing.md`). All playbook modules are
   `ansible.builtin.*`, so no Galaxy collections/`requirements.yml` are
   needed.

5. **Scope.** `molecule test --all` from `client/ansible` so every scenario
   under it is exercised (today just `default`; future-proof for more).

## Verification constraint (called out in the issue)

The scheduled-run sandbox has **no Docker daemon**, so `molecule test` cannot
be converged locally here. Verification is therefore:
- YAML validity + structural invariants asserted by a Vitest guard
  (`server/tests/integration-workflow.test.ts`), mirroring the existing
  `docker-compose.test.ts` / `dockerfile-playbooks.test.ts` infra-file guards
  (read → `yaml.parse` → zod-validate → assert);
- the job actually converging on the PR's CI run (watch + iterate).

## Deliverables

- `.github/workflows/integration.yml` — new `molecule` job (append-only; other
  jobs untouched).
- `server/tests/integration-workflow.test.ts` — guard: workflow parses; the
  `molecule` job exists, runs on `ubuntu-22.04`, installs molecule via `pip`
  (not npm), runs `molecule test`, and PR-gates on `client/ansible/`; and the
  dashboard dep tree stays molecule-free.
- `docs/testing.md` — note that CI now runs molecule (on ansible changes +
  nightly), so it is no longer a purely local step.

## Out of scope (tracked elsewhere)

- Playbook-specific live Molecule assertions (AppArmor #242, e2guardian #215,
  activitywatch privesc #360) — those add scenario *content*; this issue only
  stands up the CI harness that runs whatever scenarios exist.
