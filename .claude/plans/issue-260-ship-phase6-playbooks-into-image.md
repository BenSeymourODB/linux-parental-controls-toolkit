# Issue #260 — Ship the Phase-6 Ansible playbooks into the dashboard image

Roadmap: `docs/roadmap.md` → Phase 6 (Ansible orchestration / first-run sync).

## Problem

The first-run venv bootstrap (#39, landed in #259) syncs playbooks from an
in-image read-only source (`PCT_ANSIBLE_PLAYBOOK_SRC`, default
`/app/ansible/playbooks`) into the `/data` volume's `playbooks/`. The sync is
complete and tested, but **the image does not contain the playbooks**, so the
sync is a logged no-op on the real image.

Root cause: a build-context mismatch.

- The image build context is `server/` (`ci.yml` `docker-build`,
  `license-guard.yml`, `release.yml`, `docker-compose.yml`,
  `scripts/screenshots/run.sh`). `server/Dockerfile` only `COPY`s from within
  that context.
- The playbooks live in `client/ansible/playbooks/` — **outside** `server/`.

## Decision — Option 1 (repo-root build context)

The issue lists three options. **Option 1** (root context + `-f
server/Dockerfile`) is chosen because it is the only option where *every* build
path works with no extra steps:

- CI `docker-build`, nightly `license-guard`, `release.yml` (build-push-action),
  `docker-compose` (`docker compose up --build`), the screenshots helper, and a
  plain local `docker build` all pick the playbooks up automatically.
- Option 2 (vendor into `server/` before the build) needs a fragile pre-build
  copy step that `docker compose` / local builds can't run cleanly.
- Option 3 (relocate playbooks under `server/`) contradicts the `CLAUDE.md`
  repo layout and would break the `ansible-lint` job that lints
  `client/ansible/`.

License boundary is unaffected: the playbooks are our own YAML; Ansible itself
is still installed only into the `/data` venv on first run. `license-guard`
stays green (the GPL-binary scan finds no `ansible`/`timekpr`/`e2guardian`
binaries — none are added).

## Changes

### Phase 1 — build-context migration + COPY playbooks
- `server/Dockerfile`: rebase every `COPY <x>` onto the root context
  (`COPY server/<x>`), keep stage internals identical, and add
  `COPY client/ansible/playbooks /app/ansible/playbooks` in the runtime stage.
  Update the header comment (context is now the repo root).
- New root `.dockerignore` (conservative: `.git`, all `node_modules`/`dist`/
  `coverage`/`build`/`.svelte-kit`, `.claude`, `docs`, `design`, env/sqlite/
  `data`). Remove `server/.dockerignore`. The failure mode of an over-broad
  ignore is only a larger context, not a broken build — so it errs toward
  *not* excluding `client/` (small) to avoid a needed-path mistake.
- `ci.yml` `docker-build`: context `.` + `-f server/Dockerfile`; add an
  image-level assertion step (`docker run … test -f …/playbooks/activitywatch.yml`).
- `license-guard.yml`: context `.` + `-f server/Dockerfile`.
- `release.yml`: `context: .` + `file: server/Dockerfile`.
- `docker-compose.yml`: `context: .` + `dockerfile: server/Dockerfile`; fix
  the comments that say the context is `server/`.
- `scripts/screenshots/run.sh`: build with root context + `-f server/Dockerfile`.

### Phase 2 — guard test + docs
- A unit guard test asserting the playbook source dir
  (`client/ansible/playbooks`) ships the expected playbooks, so the `COPY`
  source can't silently empty out.
- Update `docs/ci-cd.md` and `docs/server-deployment.md` / `CLAUDE.md` mentions
  of the `server/` build context.

## Verification
- Local: start dockerd, `docker build -f server/Dockerfile -t pct:260 .`, then
  `docker run --rm pct:260 ls /app/ansible/playbooks` shows the YAML.
- CI: `docker-build` job builds with the new context and asserts presence;
  full server gate (`format:check`, `lint`, `typecheck`, `test`) stays green.

## Deferred / out of scope
- Acceptance criterion "`GET /api/system/ansible` reports ready with playbooks
  present" is a runtime/integration assertion exercised by the existing
  bootstrap tests (#259) + the new image-level CI check; no new runtime wiring
  is needed here.
