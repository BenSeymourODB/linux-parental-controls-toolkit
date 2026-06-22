# Issue #95 — AdGuard three-mode config plumbing + external preflight

Roadmap: `docs/roadmap.md` → Phase 7. Builds on the already-merged AdGuard REST
client (`src/transport/adguard/client.ts`) and the three-mode discriminated
union already validated in `src/config.ts`.

## Goal

Wire `PCT_ADGUARD_MODE` so the dashboard behaves correctly in all three
topologies, with a startup preflight for `external`, and surface the active
mode to the API so the admin UI (#97) can display where DNS rules end up.

## What already exists (don't rebuild)

- `src/config.ts` already parses the flat `PCT_ADGUARD_*` env into a
  `discriminatedUnion("mode", [...])` with `external` requiring a password or
  token file (and a username alongside a password). So **mode validation is
  done**; #95 is the *runtime behaviour* on top of it.
- `AdGuardHomeClient` takes a resolved `AdGuardAuth` and exposes `getStatus()`.

## Reconciliation: "fail loudly" vs the deployment doc

`docs/server-deployment.md` → "First-run setup" is authoritative: the dashboard
"starts anyway with the affected feature disabled and surfaces an error in the
admin UI", and core functionality "is not blocked by a missing AdGuard Home".
So the external preflight does **not** exit the process; "fail loudly" =
a prominent `error`-level log **plus** the unhealthy state surfaced on
`GET /api/dns`. Documented in the PR.

## Design

### `transport/adguard/secrets.ts`
`resolveAdGuardAuth(adguard, { readFile })` → `Promise<AdGuardAuth | undefined>`.
- `external` with `apiTokenFile` → `{ kind: "bearer", token }`.
- `external` with `passwordFile` (+ `username`, enforced by config) →
  `{ kind: "basic", username, password }`.
- Strips a single trailing newline from the file contents (Docker
  secret-file convention).
- File-read failure → throw `AdGuardConfigError` (new typed error).
- `disabled` / `managed` → `undefined`.

### `transport/adguard/service.ts`
- Types: `DnsMode = "disabled" | "external" | "managed"`,
  `DnsHealth = "not_applicable" | "unknown" | "ok" | "unreachable" |
  "auth_failed" | "unhealthy" | "error"`, and a `DnsStatus` snapshot
  (`mode`, `configured`, `health`, `baseUrl`, `checkedAt`, `detail`).
- `AdGuardService`:
  - `disabled` → inert; `status.health = "not_applicable"`, `getClient()` null.
  - `external` → lazily builds the `AdGuardHomeClient` (resolving creds via
    `secrets.ts`); `runPreflight(logger?)` calls `getStatus()`, maps the result
    to health (`ok` when reachable + `running === true`; `unhealthy` when
    `running === false`; `auth_failed` for `AdGuardAuthError`; `unreachable`
    for `AdGuardUnreachableError`; `error` otherwise, incl. credential-file
    read failures), records `checkedAt`/`detail`, and logs loudly on non-ok.
  - `managed` → mode routed only; `status.health = "unknown"`,
    `detail = "managed-mode supervisor not yet available (#96)"`,
    `getClient()` null (the supervisor wires the instance + creds in #96).
  - `status` getter returns an immutable snapshot.
- `createAdGuardService(adguard, deps?)` factory; deps inject `fetch`,
  `readFile`, `now` for tests.

### Wiring — `web/app.ts`
- `BuildAppOptions.adguard?: AdGuardService` seam (mirrors the `db` seam).
- Build the service from `settings.adguard` when not injected; decorate
  `app.adguard`.
- `onReady` hook runs `app.adguard.runPreflight(app.log)` (no-op for
  disabled/managed — no network). Default test settings are `disabled`, so the
  existing suite makes no network calls.

### API — `api/dns/`
- `dtos.ts`: `dnsStatusResponseSchema` + `toDnsStatusResponse(status)`.
- `routes.ts`: `GET /api/dns` behind `requireAdmin`, returns the snapshot.
- `index.ts`: barrel; re-exported from `api/index.ts`; registered in
  `api/plugin.ts`.

## Tests
- `tests/transport/adguard/secrets.test.ts` — bearer/basic/none, newline strip,
  read failure → `AdGuardConfigError`.
- `tests/transport/adguard/service.test.ts` — all three modes; preflight health
  mapping for ok / unhealthy / unreachable / auth / parse-or-other / cred-read
  failure; loud log on failure; `getClient()` per mode; snapshot immutability;
  idempotent re-preflight.
- `tests/api/dns/routes.test.ts` — `401` without admin; `200` snapshot for
  disabled/external(ok)/external(unreachable)/managed via injected service.

## Deferred (tracked)
- `managed`-mode supervisor (first-run fetch + supervision) → **#96**.
- Per-client blocklists + admin UI rendering the mode → **#97**.
