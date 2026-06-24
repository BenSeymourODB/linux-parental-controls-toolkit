# syntax=docker/dockerfile:1
#
# Dashboard image — single multi-stage Node 22 build (#6).
#
# The published image is *dashboard code only*. It deliberately contains
# NO GPL binaries: Ansible is installed into an isolated venv inside the
# /data volume on first run, AdGuard Home is fetched at runtime (managed
# mode) or pointed at an external instance, and the client-side GPL tools
# (Timekpr-nExT, e2guardian, ActivityWatch) live on the client. See
# docs/server-deployment.md and docs/licensing-analysis.md, enforced by
# .github/workflows/license-guard.yml.
#
# Build context is the REPO ROOT, built with `-f server/Dockerfile` (see
# .github/workflows/ci.yml → docker-build and docker-compose.yml). The root
# context is required so the runtime stage can COPY the server-orchestrated
# Ansible playbooks from client/ansible/playbooks/ — which sit outside
# server/ — into the image (#260). server/frontend/ is therefore referenced
# as server/frontend/ below; a conservative root .dockerignore keeps the
# context lean.

# ---------------------------------------------------------------------------
# Stage 1: build the SvelteKit frontend (/admin + /app) to static assets.
# adapter-static prerenders every route into frontend/build/.
# ---------------------------------------------------------------------------
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend

COPY server/frontend/package.json server/frontend/package-lock.json ./
RUN npm ci

COPY server/frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: compile the TypeScript backend and resolve production deps.
#
# python3/make/g++ are installed only in this throwaway stage so
# better-sqlite3's native binding compiles even when no prebuilt binary
# matches the target. They never reach the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src/ ./src/
RUN npm run build

# Strip dev dependencies in place, leaving the already-compiled native
# better-sqlite3 binding so the runtime stage can copy node_modules as-is
# (no recompile, no build tools in the final image).
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3: runtime. Compiled output + production node_modules + static
# frontend, plus a stock python3 (python3-venv, PSF-licensed — NOT GPL)
# used solely by first-run setup to create the isolated Ansible venv in
# the /data volume. No dashboard code is Python.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-venv \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies and compiled backend.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# package.json gives Node "type": "module" for ESM resolution of dist/.
COPY --from=builder /app/package.json ./package.json
# Committed drizzle-kit migrations, reconciled into /data on start (Phase 2).
# Copied straight from the build context (not the builder stage, which only
# carries the TypeScript sources it compiles).
COPY server/drizzle ./drizzle

# Server-orchestrated Ansible playbooks (#260). The first-run bootstrap
# (#259) syncs these from PCT_ANSIBLE_PLAYBOOK_SRC (default
# /app/ansible/playbooks) into the /data venv directory. These are our own
# YAML — Ansible itself is never bundled (it installs into the /data venv),
# so license-guard stays green.
COPY client/ansible/playbooks /app/ansible/playbooks

# Prerendered frontend (served at /admin and /app once the static mount
# lands in Phase 2; carried in the image now so the asset path is settled).
COPY --from=frontend-builder /app/frontend/build ./frontend

# First-run setup + server launch.
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Canonical policy store, Ansible venv, AdGuard payload, logs, secrets.
VOLUME ["/data"]

# Dashboard HTTP surface (docs/server-deployment.md → first-run step 5).
EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
