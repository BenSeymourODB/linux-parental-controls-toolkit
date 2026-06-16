# Plan: `server/Dockerfile` for the dashboard image (#6)

Roadmap: `docs/roadmap.md` → Phase 1. Unblocks #7 (local dev compose).

## Goal

Add `server/Dockerfile` so CI's `docker-build` and `license-guard` jobs
stop skipping and the dashboard ships as a single multi-stage Node 22
image with **no GPL binaries** inside it.

## Acceptance criteria (from the issue)

- Multi-stage `node:22-slim` build:
  - builder stage: `npm ci`, `npm run build`, plus the `server/frontend/`
    SvelteKit build.
  - runtime stage receives only `dist/`, production `node_modules`, and
    the static frontend output.
- Runtime installs the distro `python3-venv` (PSF, **not** GPL) solely so
  first-run setup can create the isolated Ansible venv in `/data`.
- Default `CMD`/entrypoint runs the compiled server (`node dist/main.js`)
  via an entrypoint that performs first-run setup.
- Image builds green in CI's `docker-build` job.
- `license-guard.yml` passes (no `ansible*`/`timekpr*`/`e2guardian*`/
  `adguardhome` binaries in the image).
- `/data` mount point documented.

## Design

Build context is `server/` (per `.github/workflows/ci.yml` →
`docker-build`: `docker buildx build … server/`). `server/frontend/` is
inside that context.

Three stages, all `node:22-slim`:

1. **`frontend-builder`** — `npm ci` + `npm run build` in
   `server/frontend/`; emits prerendered static assets to `build/`
   (`admin.html`, `app.html`, `_app/…`).
2. **`builder`** — install throwaway build tools (`python3`, `make`,
   `g++`) so `better-sqlite3` compiles even when no prebuilt binary
   matches; `npm ci`; `npm run build` (tsc → `dist/`); then
   `npm prune --omit=dev` so the already-compiled production
   `node_modules` (with the native `better-sqlite3` binding) can be
   copied as-is — no recompile in the runtime stage. Build tools live
   only in this throwaway stage, never the final image.
3. **`runtime`** — `python3-venv` via apt (first-run Ansible venv);
   copy `node_modules`, `dist/`, `drizzle/`, `package.json` from
   `builder` and `build/` from `frontend-builder`; copy the entrypoint;
   `EXPOSE 8000`, `VOLUME /data`, `ENTRYPOINT` → entrypoint → `node
   dist/main.js`.

### Entrypoint (`server/docker-entrypoint.sh`)

Idempotent, runs on every start. In-scope now: ensure the documented
`/data` volume layout exists, then `exec node dist/main.js`. The heavier
first-run steps are deferred to their roadmap phases and tracked in a
follow-up issue:

- Schema migration (drizzle-kit migrations → `policy.sqlite`) — Phase 2
  (the runtime DB connection lands then; see #34).
- Ansible venv bootstrap (`pip install ansible-core`) — Phase 6.
- AdGuard Home fetch/supervise (managed mode) — Phase 7.
- SSH key bootstrap (`id_ed25519`) — Phase 4.

## Deferred (tracked by follow-up issues, linked from the PR)

- **Container first-run setup** (migration / Ansible venv / AdGuard fetch
  / SSH keygen in the entrypoint).
- **Serve the SvelteKit build via `@fastify/static`** at `/admin` and
  `/app` (Phase 2, with the real UI). The image already carries the build
  output; only the live mount is deferred. `server/frontend/README.md`
  updated so it no longer couples the mount to #6.

## Validation

- Frontend build locally: `cd server/frontend && npm ci && npm run build`
  (done — emits `build/`).
- Backend gate: `npm run format:check && npm run lint && npm run
  typecheck && npm test`.
- Image build + license-guard: validated in CI (local Docker cannot pull
  the base-image blobs under this environment's network policy). Monitor
  the `docker-build` and `license-guard` jobs after pushing.
