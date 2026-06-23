# ADR 0009 — AdGuard Home managed mode runs as a child process

- **Status:** Accepted (2026-06-23)
- **Issue:** [#96](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/96)
- **Phase:** 7 (DNS filtering, optional). Implements the managed-mode supervisor
  the mode router ([#95](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/95))
  already forward-declares; the per-client-blocklist work
  ([#97](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/97))
  consumes the running instance.

## Context

`PCT_ADGUARD_MODE=managed` means "the dashboard hosts AdGuard Home itself".
`docs/server-deployment.md` already sketches the behaviour — fetch AdGuard Home
from upstream releases on first run, verify it, write it under `/data/adguard/`,
and **supervise it** — but #96 explicitly left the *supervision mechanism*
("child process **or** sibling container") to be decided here and recorded in an
ADR.

The hard constraint is the license boundary (`CLAUDE.md` → "License boundaries"
rule 5; `docs/licensing-analysis.md`): AdGuard Home is GPL, so it must never be
linked into the dashboard process or baked into the dashboard image. It has to
be fetched at runtime and reached **only over its REST API**. Both candidate
mechanisms satisfy that — the question is purely operational.

## Decision

**Run AdGuard Home as a child process** of the dashboard, supervised in-process
by `transport/adguard/supervisor.ts` (`AdGuardManagedSupervisor`):

- First-run acquisition (`acquire.ts`) downloads the pinned/latest release,
  SHA-256-verifies it against `checksums.txt`, and extracts the binary to
  `/data/adguard/AdGuardHome`.
- A minimal dashboard-owned seed `AdGuardHome.yaml` (`managed-config.ts`) is
  written once so the process boots headless instead of serving its install
  wizard; the web/REST UI binds `127.0.0.1:<PCT_ADGUARD_ADMIN_PORT>`
  (container-local — only the co-located dashboard reaches it), DNS binds
  `PCT_ADGUARD_BIND_ADDR`.
- The supervisor spawns it via `node:child_process`, restarts it with capped
  exponential backoff on an unexpected exit (resetting the counter after a
  stable run), and stops it gracefully (`SIGTERM`, escalating to `SIGKILL`) on
  dashboard shutdown. `bootstrap()` runs in the background after `listen` and
  never throws — a failed fetch leaves managed DNS `failed` with the reason on
  `GET /api/system/adguard-managed`, exactly the "feature disabled + error
  surfaced" posture the rest of first-run setup uses.

### Why not a sibling container

A sidecar/sibling container would require the dashboard to drive a container
runtime from inside its own container (docker-in-docker, or compose
orchestration of a peer service). That adds a heavyweight, environment-specific
dependency and a second deployment artefact, for **no** license or isolation
benefit: the GPL-satisfying boundary (separate process, REST-only integration)
is identical either way. A child process is also what `docs/server-deployment.md`
already documents and what the established first-run pattern
(`setup/ansible-venv.ts`, which spawns `python3`/`pip`) uses — one runtime, one
lifecycle, one status surface.

If a future deployment genuinely needs AdGuard Home as a separate container
(e.g. an operator running it on a different host), that is already served by
**`external` mode** — point the dashboard at it over REST. Managed mode exists
precisely for the "let the dashboard run it for me" case, where an in-container
child process is the simplest correct answer.

## Consequences

- The dashboard image must ship nothing AdGuard-related; the binary lives only
  in the data volume, fetched at runtime. `license-guard` stays green.
- AdGuard Home's own auto-update is left enabled at the binary level by intent
  for an unpinned install; a pinned `PCT_ADGUARD_VERSION` reconciles on a
  sentinel mismatch (mirroring the Ansible-core pin).
- The **live REST wiring** — feeding the running instance into
  `AdGuardService.getClient()` and polling its health — is deferred to a tracked
  follow-up that #97 builds on; this ADR/PR delivers the fetch + supervision
  lifecycle only.
- The seed-config field set and the binary's CLI flags are modelled from
  upstream AdGuard Home documentation. A live round-trip against the real binary
  needs a container/Docker daemon not available in the scheduled-run sandbox
  (the [#157](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/157)
  → #207 posture); it is verified separately.
