# CI/CD Pipeline

This document describes the GitHub Actions workflows and local tooling that
keep the project green. It is the companion to [`docs/testing.md`](testing.md),
which covers *what* is tested; this document covers *when* and *how*.

---

## Workflows at a glance

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Every push, every PR | Lint, unit tests, frontend build, Docker build |
| `integration.yml` | PRs to `main`, nightly 02:00 UTC | Real-tool integration tests |
| `release.yml` | Semver tags (`v*.*.*`) | Build + push Docker image, GitHub Release |
| `license-guard.yml` | PRs touching `server/**` | Scan image for GPL binaries |

All workflows gracefully skip steps for code that has not yet been scaffolded,
so they can be merged ahead of implementation (Phase 1 of the roadmap).

---

## `ci.yml` — Main CI

Runs on every push to any branch and on every pull request. Failure blocks
merge.

### Jobs

**`lint`** — Python static analysis
- `black --check` formatting
- `ruff check` linting
- `mypy --strict` type checking over `server/src/`

All three are also enforced by the pre-commit hooks (see below), so they
should never fail in CI for code developed locally.

**`test`** — Unit tests
- `pytest server/tests/ -m "not integration"` — unit tests only, no live
  services required.
- Coverage threshold: 80 % (enforced via `--cov-fail-under`). Raise the
  threshold as coverage improves; do not lower it.

**`svelte-build`** — Frontend compilation
- Builds the Jinja2+HTMX Svelte islands (`server/frontend/admin/`).
- Builds the SvelteKit PWA (`server/frontend/app/`).
- Catches TypeScript/Svelte type errors at the API boundary before they
  become runtime failures.
- Skips gracefully if the frontend directories do not exist yet.

**`shellcheck`** — Shell script linting
- Runs ShellCheck on every `*.sh` under `client/`.
- The client install script is the primary target; distro adapter scripts
  under `client/distros/` are also covered.

**`ansible-lint`** — Ansible quality gate
- Runs `ansible-lint` over everything under `client/ansible/`.
- Skips gracefully until the Ansible phase (Phase 6) lands.

**`docker-build`** — Image build verification
- Builds the `server/Dockerfile` image without pushing.
- Uses GitHub Actions cache (`type=gha`) to keep the build fast.
- Failure here means the image is broken even if all tests pass — keep it
  in CI alongside the test job, not only in the release workflow.

**`pre-commit`** — Hook suite
- Runs `pre-commit run --all-files` using the project's
  `.pre-commit-config.yaml`.
- This is a catch-all for any hook not covered by the dedicated jobs above
  (file hygiene, YAML/TOML validity, large-file guard, merge-conflict
  markers).

---

## `integration.yml` — Integration tests

Runs on PRs targeting `main` and nightly at 02:00 UTC. Also triggerable
manually via `workflow_dispatch`.

Integration jobs are *not* required to pass to merge a feature branch —
only PRs to `main` trigger them. This keeps iteration fast during feature
development while ensuring `main` is always integration-clean.

### Jobs

**`activitywatch`**
- Starts `activitywatch/aw-server:latest` as a GitHub Actions service
  container on port 5600.
- Runs `pytest server/tests/transport/activitywatch/ -m integration`.
- The `AW_SERVER_URL` env var points the transport client at the live
  container. Tests verify bucket creation, window-event ingestion, and
  `UsageSample` normalisation against a real server.

**`adguard`**
- Starts `adguard/adguardhome:latest` as a service container on port 3000.
- Runs `pytest server/tests/transport/adguard/ -m integration`.
- Tests cover the `external` mode client (REST calls to a running instance),
  blocklist push/verify, and 401/409 error handling.

**`ssh-transport`**
- Starts `lscr.io/linuxserver/openssh-server` on port 2222.
- Mounts `server/tests/stubs/` into the container's `PATH`, providing a
  stub `timekpra` script that records its CLI invocations to a file.
- Runs `pytest server/tests/transport/ssh/ -m integration`.
- Tests validate the full SSH round-trip (connect → invoke → parse stdout)
  without requiring Timekpr-nExT to be installed on the runner.
- See [`server/tests/stubs/timekpra`](../server/tests/stubs/timekpra) for
  the stub implementation.

**`migrations`**
- Creates a temporary SQLite database, runs `alembic upgrade head`, then
  `alembic downgrade base`.
- Catches broken migration scripts before they reach production.
- The database file is discarded at the end of the job.

**`client-install-dryrun`**
- Runs `client/install-client.sh` inside a fresh `ubuntu:22.04` Docker
  container with `PCT_DRY_RUN=1`.
- The dry-run flag causes the script to skip `apt install` and service
  starts while still executing all logic, conditionals, and sanity checks.
- Verifies the script exits non-zero on an unsupported distro.

---

## `release.yml` — Release and publish

Triggered by pushing a semver tag (e.g. `git tag v1.2.0 && git push --tags`).

### Steps

1. **Unit test gate** — runs the full unit suite. A failing test blocks the
   release; do not bypass this.
2. **Docker build and push** — builds the server image and pushes it to
   `ghcr.io/benseymourodb/linux-parental-controls-toolkit` with three tags:
   `v1.2.0`, `v1.2`, and `latest`.
3. **GitHub Release** — creates a GitHub Release with auto-generated notes
   and attaches `client/install-client.sh` as a release artifact. This means
   a server running a tagged release can serve the matching install script
   at `/install-client.sh`.

### How to cut a release

```bash
# Ensure main is clean and CI is green first.
git tag v1.2.0
git push origin v1.2.0
```

The workflow does the rest. Do not push tags from feature branches.

---

## `license-guard.yml` — License boundary check

Triggered on PRs that touch anything under `server/`. See
[`docs/licensing-analysis.md`](licensing-analysis.md) for the full
reasoning behind the license boundaries.

Builds the Docker image and runs `find` inside it, looking for the
following GPL binary names:

- `ansible`, `ansible-*`, `ansible_*`
- `timekpr*`
- `e2guardian*`
- `adguardhome`

If any match, the job fails. This is a hard invariant: the image must
remain GPL-binary-free. GPL components are installed at first-run into the
data volume or kept on the client machine, never bundled into the image.

---

## Local development tooling

### Pre-commit hooks

Install once after cloning:

```bash
pip install pre-commit
pre-commit install
```

The hooks run automatically on every `git commit`. They cover the same
checks as CI (black, ruff, mypy, shellcheck, ansible-lint) plus file
hygiene. Running them locally means CI lint failures should be rare.

To run all hooks manually without committing:

```bash
pre-commit run --all-files
```

To update hook revisions (do this periodically and commit the result):

```bash
pre-commit autoupdate
```

### Running unit tests locally

```bash
cd server
pip install -e ".[dev]"
pytest tests/ -m "not integration" -q
```

### Running integration tests locally

Each integration test job has a corresponding Docker Compose snippet in
[`docs/testing.md`](testing.md) so you can reproduce the exact service
configuration locally.

---

## Adding a new workflow or job

- Keep each job focused on one concern (lint, test, build, scan).
- Add skip guards (`if [ -d path ]; then ...`) for any step that depends on
  code that does not exist yet. Remove the guard when the code lands.
- Mark slow or service-dependent tests with `@pytest.mark.integration` so
  the unit-test job can exclude them with `-m "not integration"`.
- Update this document and `docs/testing.md` when you add a new job that
  tests a new component.
