# Issue #20 — ActivityWatch integration job pulls a non-existent Docker image

## Problem

`.github/workflows/integration.yml` → `activitywatch` job runs
`docker run -d activitywatch/activitywatch:latest`. That image does not
exist on Docker Hub — ActivityWatch publishes no official container image,
so the step fails with `pull access denied`. `docs/testing.md` repeats the
mistake with a different non-existent image (`activitywatch/aw-server:latest`)
in its local Docker Compose recipe. The job is currently dormant (it guards
on the presence of `*.int.test.ts` files, per the #19 fix), but the broken
bootstrap must be corrected before the first real ActivityWatch transport
tests land.

## Decision

Adopt the issue's **Option 1** (run a real `aw-server` under our control),
refined to use the upstream **prebuilt release** rather than building the
Rust crate from source:

- Download the pinned `activitywatch-vX.Y.Z-linux-x86_64.zip` from the
  upstream GitHub release. The bundle contains the headless
  `aw-server-rust` binary.
- Pin both the **version** (`v0.13.2`) and the archive **SHA-256** so the
  artifact is reproducible and under our control (mitigates the "community
  image may disappear/change" risk the issue calls out for Option 2).
- Extract just `activitywatch/aw-server-rust/aw-server-rust`, run it
  headless (`--host --port --dbpath --no-legacy-import`), and wait on
  `GET /api/0/info`.
- We talk to it over its **REST API only** — no source-level integration,
  no GPL boundary crossed (aw-server is MPL-2.0 regardless; it is a
  test-time external service, never bundled in the dashboard image).

Verified locally: the v0.13.2 bundle's `aw-server-rust` starts headless and
serves `{"hostname":...,"version":"v0.13.2 (rust)",...}` on
`/api/0/info`.

## Why not the other options

- **Option 2 (community image, pinned digest):** still depends on a
  third-party publisher; the release bundle + checksum gives the same
  pinning guarantee from the upstream project itself.
- **Option 3 (spawn from a Vitest `globalSetup`):** `vitest.integration.config.ts`
  is shared by the AdGuard and SSH integration jobs too, so an
  unconditional global setup would start aw-server for unrelated tests.
  Keeping the bootstrap in the job step mirrors how the `adguard` and
  `ssh-transport` jobs already own their service bootstrap.

## Changes

1. `scripts/start-aw-server.sh` — single source of truth: download (cached),
   checksum-verify, extract, launch headless, health-poll `/api/0/info`.
   Env-overridable: `AW_VERSION`, `AW_SHA256`, `AW_HOST`, `AW_PORT`,
   `AW_CACHE`. shellcheck-clean.
2. `.github/workflows/integration.yml` — `activitywatch` job's
   "Start ActivityWatch server" step calls the script instead of the broken
   `docker run`; the #20 NOTE comment in the job header is replaced with a
   one-line description of the resolved approach.
3. `docs/testing.md` — replace the non-existent `activitywatch/aw-server:latest`
   compose service with the native `scripts/start-aw-server.sh` recipe
   (aw-server has no image), keeping AdGuard + ssh-target on Compose.

## Tests / verification

- shellcheck on `scripts/start-aw-server.sh` (run manually; CI's shellcheck
  job is scoped to `client/`).
- Manual end-to-end: download → checksum → extract → run → `/api/0/info`
  200, confirmed in the implementing session.
- Full TS quality gate (`format:check`, `lint`, `typecheck`, `test`) stays
  green — no `server/` source touched.

## Deferred

The acceptance criterion "job runs to completion on a PR that lands real
ActivityWatch transport tests" can only be fully exercised once those
`*.int.test.ts` files exist (a later phase). This PR makes the bootstrap
correct and verified so that future PR is unblocked.
