# Contributing

Thanks for working on the Linux parental-controls toolkit. This file is the
single place to look for the local development loop — prerequisites, the
quality gate, how tests run, and the branch/PR conventions. It is aimed at
both human contributors and AI coding agents.

Before writing code, read [`CLAUDE.md`](CLAUDE.md): it holds the
non-negotiable rules (the license boundaries, the bounded tamper-resistance
posture, and the tech-stack constraints). The design documents under
[`docs/`](docs/) are authoritative — never contradict them; if a change needs
a documented decision to move, update the doc in the same PR.

---

## Prerequisites

- **Node.js 22 LTS.** The backend targets Node 22 (`"engines": { "node": ">=22" }`)
  with ESM modules and TypeScript `strict: true`. Use a version manager
  (`nvm`, `fnm`, `asdf`, …) if you juggle multiple Node versions.
- **Python 3** with [`pre-commit`](https://pre-commit.com/) — only needed to
  run the git hooks locally (see below). `pipx install pre-commit`,
  `pip install pre-commit`, or `brew install pre-commit` all work.
- **Docker** (with Compose) — for running the dashboard from source and for
  the integration-test service containers.

The dashboard itself contains **no Python code**; the only Python in this
project is `pre-commit` (a dev convenience) and the stock interpreter the
runtime image carries solely to host the first-run Ansible venv. Everything
you build and test here is TypeScript on Node.

## First-time setup

```bash
git clone https://github.com/BenSeymourODB/linux-parental-controls-toolkit.git
cd linux-parental-controls-toolkit

# Backend dependencies (the TS pre-commit hooks also run from here)
cd server && npm ci && cd ..

# Install the git hooks (runs the same checks as CI before each commit)
pre-commit install
```

The backend lives in [`server/`](server/); nearly every command below is run
from that directory. The repository layout is described in
[`CLAUDE.md`](CLAUDE.md) → "Repository layout".

## Pre-commit hooks

`pre-commit install` wires up the hooks in
[`.pre-commit-config.yaml`](.pre-commit-config.yaml). They run automatically
on every `git commit` and cover the same checks as CI, so a clean local commit
should almost never fail the CI `lint` job:

- **prettier** — formatting check across `server/` (`npm run format:check`).
- **eslint** — `typescript-eslint` lint across `server/` (`npm run lint`).
- **tsc --noEmit** — strict type-check (`npm run typecheck`).
- **shellcheck** — lints every `client/**/*.sh`.
- **file hygiene** — trailing whitespace (Markdown two-space line breaks are
  preserved), end-of-file newline, YAML/JSON validity, merge-conflict markers,
  and a 500 KB large-file guard.

The TypeScript hooks shell out to the `server/` npm scripts, so the hook and
CI share one source of truth. They require `cd server && npm ci` to have run
once after cloning.

Run every hook against the whole tree without committing:

```bash
pre-commit run --all-files
```

`ansible-lint` is intentionally kept in CI only (not in the hook set) until
real playbooks land in Phase 6. Never bypass the hooks with `git commit
--no-verify`.

## The quality gate

The full backend gate mirrors the CI `lint` and `test` jobs. Run it from
`server/` before pushing:

```bash
cd server
npm run format:check   # prettier --check .
npm run lint           # eslint .
npm run typecheck      # tsc --noEmit  (strict: true)
npm test               # vitest unit tests + 80% coverage gate
```

All four must pass. Useful fix-up variants while iterating:

```bash
npm run format         # prettier --write .   (auto-format)
npm run lint:fix       # eslint . --fix
```

Coverage is gated at **80 %** (lines/branches/functions/statements) via the
Vitest thresholds. Raise the threshold as coverage improves; never lower it,
and never weaken or delete a test to make a change pass — if a test reveals a
real problem, fix the design.

## Running tests

The suite has two tiers, selected by filename (see
[`docs/testing.md`](docs/testing.md) for the full philosophy and per-module
targets):

### Unit / contract tests (fast, no live services)

```bash
cd server
npm test               # runs tests/**/*.test.ts, excludes *.int.test.ts
```

These mock at the subprocess (`node:child_process`) and REST (`undici`
`MockAgent`) boundaries, use an in-memory SQLite database for policy tests, and
exercise HTTP routes via Fastify's `app.inject()` — no sockets, no ports, no
network. This is the suite CI's `test` job runs and the one to keep green while
developing.

### Integration tests (slower, real upstream tools)

Integration tests are named `*.int.test.ts`, excluded from `npm test`, and run
against real service containers (ActivityWatch, AdGuard Home, OpenSSH):

```bash
cd server
npm run test:integration
```

They need the Docker services up first. The exact Compose recipe and the env
vars to point the transports at the local services live in
[`docs/testing.md`](docs/testing.md) → "Integration tests — local
reproduction". In CI these run via `integration.yml` on PRs to `main` and
nightly, not on every push.

## Frontend dev loop

The dashboard has one SvelteKit project at [`server/frontend/`](server/frontend/)
(Svelte 5, `@sveltejs/adapter-static`) providing both the `/admin` and `/app`
surfaces as statically prerendered assets. It has its own toolchain and is
deliberately **excluded from the backend's ESLint / Prettier / tsc scope** —
run the backend gate from `server/` and the frontend checks from
`server/frontend/`:

```bash
cd server/frontend
npm ci
npm run dev      # vite dev server with HMR (http://localhost:5173)
npm run build    # svelte-check + vite build → ./build
npm run preview  # serve the built ./build locally
npm run check    # svelte-check only (TS at the Svelte/API boundary)
```

`npm run build` runs `svelte-check` before `vite build`, and `adapter-static`
is configured `strict: true`, so the build fails if any route is not
prerenderable. The output (`server/frontend/build/`) is a build artefact: it is
git-ignored and produced at image-build time, never committed. `/` and `/api/*`
are owned by the Fastify backend, not this project. See
[`server/frontend/README.md`](server/frontend/README.md) for details.

## Running the dashboard locally

```bash
# (optional) override defaults; the dashboard runs without this file
cp .env.example .env

docker compose up --build
```

The dashboard then serves on <http://localhost:8000> (`GET /` → the
"hello, no policy yet" placeholder; `GET /healthz` → the liveness probe).
Every setting and its default is documented in
[`.env.example`](.env.example) and
[`docs/server-deployment.md`](docs/server-deployment.md).

## Branch and PR conventions

From [`CLAUDE.md`](CLAUDE.md) → "Working on this repo":

- **Develop on a feature branch.** Agents work on the session's designated
  `claude/*` branch; do not push elsewhere without explicit approval.
- **Track non-trivial work with an issue** on the
  [roadmap project](https://github.com/users/BenSeymourODB/projects/2).
  Sequencing follows [`docs/roadmap.md`](docs/roadmap.md) by phase.
- **Keep PRs small and focused** on one milestone item at a time.
- **Justify new dependencies.** A new dependency needs a sentence in the PR
  description explaining why an existing one does not suffice.
- **Land tests with the code.** Every behaviour change ships with tests under
  `server/tests/` mirroring the source layout.
- **Respect the license boundaries** (`CLAUDE.md` → "License boundaries") and
  the **bounded tamper-resistance posture** (`CLAUDE.md` → "Tamper resistance
  is deliberately bounded"). If a task seems to require crossing either line,
  stop and raise it in the issue thread instead of building it.

Never force-push a shared branch, amend a published commit, or bypass the
pre-commit hooks.

## Where to read next

| Document | What's in it |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | The hard rules: tech stack, license boundaries, tamper-resistance ceiling, code conventions. |
| [`docs/architecture.md`](docs/architecture.md) | Component / data-flow diagrams, the policy model, and the external-integration contract. |
| [`docs/ci-cd.md`](docs/ci-cd.md) | The GitHub Actions workflows and local tooling — *when* and *how* checks run. |
| [`docs/testing.md`](docs/testing.md) | The testing strategy, mock patterns, per-module coverage targets, and the integration-test recipe. |
| [`docs/roadmap.md`](docs/roadmap.md) | The phased milestone plan that orders the work. |
</content>
</invoke>
