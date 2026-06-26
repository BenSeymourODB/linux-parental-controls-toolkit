# Issue #96 — AdGuard managed-mode supervisor (first-run fetch + child-process supervision)

Roadmap: `docs/roadmap.md` → Phase 7 (DNS filtering, optional).

## Goal

When `PCT_ADGUARD_MODE=managed`, fetch AdGuard Home from upstream releases into
the data volume on first run, then supervise it as a **child process** —
per `docs/server-deployment.md` → "First-run setup" step 3 and "AdGuard Home
deployment modes". AdGuard binaries are **never** baked into the dashboard
image (license boundary, `docs/licensing-analysis.md`): they are fetched at
runtime and run as a separate process, exactly the boundary the REST-only
integration already preserves.

## Decision: child process, not sidecar container (ADR 0009)

The issue leaves "child process vs sibling container" open. We pick **child
process**, recorded in `docs/adr/0009-adguard-managed-supervisor.md`:

- It is what `docs/server-deployment.md` already documents ("supervises it as a
  child process", "runs AdGuard as a separate child process under
  `/data/adguard/`").
- It mirrors the established first-run pattern (`setup/ansible-venv.ts` spawns
  `python3`/`pip` as subprocesses) — one runtime, one lifecycle, in-process
  supervision with a status the admin UI can read.
- A sidecar container would require the dashboard to drive a container runtime
  from inside its own container (docker-in-docker / compose orchestration),
  adding a heavyweight dependency for no license or isolation benefit — the
  process boundary that satisfies the GPL analysis is identical either way.

## Scope (this PR — the issue's literal title)

A unit-testable slice with injected seams (no Docker, no real network — the
same posture `setup/ansible-venv.ts` and the SSH transport tests use):

1. **Release helpers** (`transport/adguard/release.ts`) — pure: map
   `process.platform`/`arch` → AdGuard asset name (`AdGuardHome_linux_amd64`,
   `_arm64`, `_386`, `_armv7`); build the release download URL + the
   `checksums.txt` URL for a version tag; the `/releases/latest` API URL.
2. **Tar extraction** (`transport/adguard/targz.ts`) — pure: `gunzipSync`
   (`node:zlib`) + a minimal USTAR reader that returns one regular-file entry
   by suffix (`AdGuardHome/AdGuardHome`). No new dependency — a tar is 512-byte
   header blocks; extracting one file is ~50 lines and fully unit-testable.
3. **Acquisition** (`transport/adguard/acquire.ts`) — `acquireAdGuardHome`:
   idempotent (presence + version sentinel); resolve version (pinned
   `PCT_ADGUARD_VERSION`, else `/releases/latest`); download the tarball +
   `checksums.txt` via injected `fetch`; **verify SHA-256** (`node:crypto`)
   against the checksum line for our asset; extract the binary; write `0755` +
   a version sentinel. Injected `fetch` + fs seams; never touches the real
   network in tests.
4. **Seed config** (`transport/adguard/managed-config.ts`) — render a minimal
   dashboard-owned `AdGuardHome.yaml` (web UI bound to `127.0.0.1:<adminPort>`,
   DNS to `PCT_ADGUARD_BIND_ADDR`) **only when absent**, so AdGuard boots
   headless instead of serving its install wizard. Documented as a seed AdGuard
   migrates/expands on first boot; not clobbered on subsequent runs.
5. **Supervisor** (`transport/adguard/supervisor.ts`) —
   `AdGuardManagedSupervisor`: a state machine
   (`idle`/`fetching`/`starting`/`running`/`stopped`/`failed`) with a
   `status` snapshot, mirroring `AnsibleVenvSupervisor`. `bootstrap(logger)`
   never throws: acquire → seed config → `start()`. `start()` spawns the binary
   (`-c <conf> -w <dir> --no-check-update`) via an injected `spawn`; on an
   unexpected exit it restarts with capped backoff (injected `delay`), giving up
   to `failed` after a cap; `stop()` (used by `onClose`) sends `SIGTERM` then
   escalates to `SIGKILL` after a deadline.
6. **API status** — `GET /api/system/adguard-managed` mirroring
   `/api/system/ansible`: a read-only `requireAdmin` snapshot for the admin UI.
   DTO + mapper in `api/system/dtos.ts`.
7. **Wiring** — `config.ts` gains `version?` + `dataDir` on the managed branch;
   `buildApp` decorates `app.adguardManaged` (built only in managed mode, else a
   null-object inert supervisor); `main.ts` fires `bootstrap()` after `listen`
   (backgrounded, never blocks startup) and `stop()`s it on shutdown.

## Deferred (tracked follow-up — will file + link)

- Wiring the **running managed instance into `AdGuardService.getClient()`** +
  live REST health polling (so `GET /api/dns` health reflects the managed
  instance). That is the consumer the per-client-blocklist work (#97) needs and
  composes cleanly on top of the running process. Filed as a new issue, linked
  from the PR.
- Live managed-mode bring-up against the **real** AdGuard binary (needs a
  container / Docker daemon not available in the scheduled-run sandbox — the
  #157 → #207 posture). The config schema + CLI args are modelled from upstream
  docs and noted as such in the ADR.

## License boundary

Unchanged. AdGuard Home is fetched from upstream **at runtime** into the data
volume and run as a **separate child process**; no GPL code is linked in-process
and no GPL binary is added to the dashboard image (`CLAUDE.md` → "License
boundaries" rule 5; `docs/licensing-analysis.md`). `license-guard` unaffected.
No new dependency.

## Tests

- `release.test.ts` — platform/arch mapping, URL builders.
- `targz.test.ts` — extract a file from a hand-built gzip+tar buffer; missing
  entry → error.
- `acquire.test.ts` — idempotent no-op when present; download + checksum verify
  happy path; checksum mismatch → error (no binary written); version resolution
  (pinned vs latest); fetch failure surfaced.
- `managed-config.test.ts` — renders expected YAML; no-clobber when present.
- `supervisor.test.ts` — bootstrap happy path (fetching→running); acquire
  failure → failed (never throws); unexpected exit → restart with backoff;
  restart cap → failed; `stop()` SIGTERM→SIGKILL escalation; status snapshot.
- `system` route test — `GET /api/system/adguard-managed` behind `requireAdmin`,
  serialises the snapshot; inert in non-managed modes.

Full local gate (format/lint/typecheck/unit+coverage ≥80%) is verifiable here.

## Phasing

- **Phase A:** release helpers + targz + acquire + config template (+ tests).
- **Phase B:** supervisor + facade + ADR (+ tests).
- **Phase C:** config fields + DTO/route + app/main wiring + doc update
  (+ tests). Open the draft PR at the first push.
