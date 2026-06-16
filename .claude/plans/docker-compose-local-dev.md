# Plan — Top-level `docker-compose.yml` for local dev (#7)

Roadmap: `docs/roadmap.md` → Phase 1 ("a basic `docker-compose.yml` example
for local development"). Blocked-by #6 (image) and #10 (settings loader),
both merged.

## Goal

One-command local bring-up of the dashboard, building the image from source
so local changes are reflected, reading config from a gitignored `.env`
(template `.env.example` already checked in), and persisting state to a host
data directory.

## Deliverables (acceptance criteria from #7)

1. `docker-compose.yml` at the repo root with a single `dashboard` service.
   - Builds the image from `./server` (context = `server/`, matching the
     Dockerfile's build context — see `.github/workflows/ci.yml` →
     `docker-build`). Local dev builds from source rather than pulling the
     published GHCR image used in the production reference files in
     `docs/server-deployment.md`.
   - Mounts a host directory (`./data`) as the dashboard's `/data` volume
     (the canonical state tree from `docs/server-deployment.md` → "Volume
     layout"). `./data` is already covered by `.gitignore` (`/data/`).
   - Reads env from `.env` via `env_file` with `required: false`, so
     `docker compose up` works out of the box (the settings loader has safe
     defaults: AdGuard `disabled`, `DATABASE_URL=/data/policy.sqlite`)
     and picks up overrides once the user copies `.env.example` → `.env`.
   - Publishes `8000:8000` (dashboard HTTP surface).
   - `/healthz` healthcheck (the probe added in #5), run via Node's global
     `fetch` (no curl in the `node:22-slim` runtime image).
   - `restart: unless-stopped`.

2. `README.md` — add a "Quick start (local development)" section.

3. Guard test under `server/tests/` asserting the compose file's invariants
   (service name, build context, `/data` mount, `8000` port, `env_file`,
   and that no AdGuard sidecar leaked in — that's Phase 7, explicitly out of
   scope per #7).

## Out of scope (per #7)

- AdGuard sidecar (Phase 7).
- Integration-test compose file (already in `docs/testing.md`).

## License-boundary note

No transport or packaging changes. The compose file builds the existing
`server/Dockerfile` (which already keeps GPL binaries out of the image) and
adds no services that bundle GPL code. N/A for in-process linkage.
