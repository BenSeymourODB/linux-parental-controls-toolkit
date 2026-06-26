# Issue #283 — Managed AdGuard: wire the running instance into `AdGuardService.getClient()` + live health polling

Phase 7 (DNS filtering). Builds on #95 (`AdGuardService` mode router +
external preflight) and #96 (`AdGuardManagedSupervisor` lifecycle). No design-doc
change required — this is the "REST wiring" layer ADR 0009 anticipates.

## Goal

In `managed` mode, treat the dashboard-supervised AdGuard Home instance the same
way `external` mode treats the homelab's instance:

1. `AdGuardService.getClient()` returns an `AdGuardHomeClient` pointed at the
   supervisor's `adminEndpoint` **when the supervisor reports `running`** (today
   it always returns `null` in managed mode).
2. The same `GET /control/status` health probe `external` uses runs against that
   local endpoint, so `GET /api/dns` reflects the managed instance
   (reachable/running) instead of a permanent `unknown`.
3. Health is polled on a cadence so a managed-instance crash/restart becomes
   visible in the admin UI.

## License boundary

Unchanged. REST-only over HTTP to `http://127.0.0.1:<adminPort>`; no AdGuard
code linked, no GPL binary added to the image (`CLAUDE.md` → "License
boundaries" rule 4). The supervised process boundary (#96) is untouched.

## Design

### A narrow seam, not a hard coupling

`AdGuardService` learns about the supervisor through a structural interface, so
the service does not import the supervisor's behaviour (no cycle; supervisor
never imports the service):

```ts
export interface ManagedInstanceSource {
  readonly status: Pick<AdGuardManagedStatus, "state" | "adminEndpoint" | "detail">;
}
```

`AdGuardManagedSupervisor` satisfies this structurally (its `status` getter
returns the full snapshot). It is injected via a new optional
`AdGuardServiceDeps.managed`.

### `getClient()` (managed branch)

- mode `managed` + source present + `state === "running"` → build (once, cached)
  and return an `AdGuardHomeClient` at `adminEndpoint`. **No auth** — the seed
  config (`managed-config.ts`) writes `users: []`, so the local instance is
  unauthenticated; managed settings carry no credential files.
- otherwise → `null` (no source wired, or not running).

### `runPreflight()` (managed branch)

- `state === "running"` → probe `GET /control/status` exactly like external:
  `ok` / `unhealthy` (reachable, not running) / `unreachable` / `error`
  (malformed / non-2xx). `configured: true`, `baseUrl = adminEndpoint`.
- non-running state → map to health without a network call, surfacing the
  supervisor's own `detail`:
  - `idle` / `fetching` / `starting` → `unknown`
  - `stopped` → `unreachable`
  - `failed` → `error`
  `configured: false` (no client wired yet).
- no source wired (defensive) → `unknown`.

`#probeManaged` does **not** log per call (the poll runs every 30 s); the poller
logs only on health *transitions* so a degrade is loud without spamming.

### Polling (`health-poller.ts`)

Mirror `transport/reapply/scheduler.ts`: a `croner` job exposing `tick()` +
`stop()`. Each tick calls `service.runPreflight()` and logs on health change
(info on recovery to `ok`, error otherwise). Default cadence `*/30 * * * * *`.

Wired by the **caller** (`main.ts`, after `listen`), not inside `buildApp` —
matching the reapply convention so building the app (and every test) starts no
timer. `buildApp` decorates a `adguardHealthPoll` holder (initially `null`) and
adds an `onClose` hook that stops it if set; `main.ts` assigns the handle in
managed mode. The poller module itself is unit-tested directly.

### `buildApp` wiring

Reorder so the supervisor is created before the service, then pass the source:

```ts
const adguard = options.adguard ?? createAdGuardService(
  settings.adguard,
  adguardManaged !== null ? { managed: adguardManaged } : {},
);
```

## Tests

- `service.test.ts` — replace the obsolete "#96 not yet available" placeholder
  test (superseded by this issue) with: no-source managed (null client,
  `unknown`); running → ok / unhealthy / unreachable / error; non-running states
  → unknown / unreachable / error; client built once & reused; managed client
  uses the injected `fetch`.
- `health-poller.test.ts` (new) — tick calls `runPreflight`; logs only on health
  transition; `stop()` is safe; default pattern exported.
- `dns.test.ts` — update the managed case: a managed service wired to a
  `running` fake source + fake `fetch` surfaces `health: "ok"` at `GET /api/dns`;
  keep a non-running case showing `unknown`.

## Deferred (out of scope, tracked)

- Live bring-up against the real AdGuard binary needs Docker (the #157 → #207
  posture); noted on the issue. Covered structurally by unit tests here.
- Per-client domain blocklists (#97) consume `getClient()` — unchanged here.
