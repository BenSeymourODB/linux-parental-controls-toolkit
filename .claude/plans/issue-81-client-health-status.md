# Plan — #81 Client health/status API (backend slice)

Roadmap: Phase 3. Issue #81 has a **backend** half (status/probe API) and a
**frontend** half (admin "Clients" page + enrol flow). The admin page depends
on the in-flight `/admin/*` shell (#53), so **this PR lands the backend
health/status API end-to-end**; the admin UI page is split into a tracked
follow-up.

## What the endpoint reports (per `Client`)

- **reachability** — `online | offline | unknown`, from an SSH probe.
- **lastSeen / enrolledAt** — persisted on the `clients` row.
- **component health** — for `timekpr-next`, `activitywatch`, `e2guardian`,
  `pct-client-bridge`, `pct-client-agent`: `ok | unhealthy | unknown` + detail.
- **queue** — offline + queued-change state: `pending`/`failed` counts and the
  per-client queued actions (reusing `transport/queue` `listForClient`), so the
  admin sees what's pending for an unreachable client.

## Design — reuse the SSH facade, build against a seam (like #84/#86)

There is **no live SSH wiring yet** (SSH-key bootstrap is #39; the queue and
telemetry both ship against injected SSH seams). So this PR:

1. `transport/health/` — the SSH-backed prober.
   - `components.ts` — the component catalogue grounded in `client/`'s install
     scripts + `self-test.sh` (which already does `systemctl is-active <unit>`):
     system services `timekpr.service`, `e2guardian.service`,
     `pct-client-bridge.service` get a `systemctl is-active` probe; the
     **per-user** components (`activitywatch` aw-server loopback,
     `pct-client-agent` `systemd --user`) are `deferred` → reported `unknown`
     (their probe shape lands with Phase 5 / 8b). `classifyServiceState` maps
     `is-active` stdout → status (`active`→ok, else→unhealthy) — pure + tested.
   - `prober.ts` — `ClientProber` interface (`probe(client) => ClientProbeResult`)
     and `SshClientProber` using the facade `exec` + `targetFromClient`. A
     retriable `SshError` (unreachable/timeout) → `offline` + all `unknown`.
2. `api/clients/health-dtos.ts` — zod DTOs (the contract): component enum,
   status enum, reachability enum, queued-action summary, `clientHealthSchema`,
   list schema, + `toClientHealthResponse` / `toQueuedActionSummary` mappers.
3. `api/clients/health-service.ts` — assembles persisted row + queue rows +
   (optional) probe result into the DTO. No prober configured → reachability
   `unknown`, components `unknown`, but queue + lastSeen + enrolledAt are real.
   A reachable probe updates `lastSeen` (deterministic via the probe's `at`).
4. `api/clients/health-routes.ts` — `GET /api/clients/health` (all) and
   `GET /api/clients/:id/health` (one), behind `requireAdmin`. Registered in
   `api/plugin.ts` with the prober **injected**; today it's `undefined`
   (degraded) until #39 plumbs SSH credentials.

## License boundary

None crossed: the prober only ever *execs* `systemctl`/component commands over
the existing SSH subprocess facade — no GPL linkage, no REST/subprocess
boundary collapsed, no Docker-image/packaging change.

## Tests (vitest, 80% gate)

- `transport/health/components` — `classifyServiceState` table; catalogue shape.
- `transport/health/prober` — online happy path (per-component classification),
  offline on retriable SSH error, deferred components → unknown, exec-failure →
  component unknown, against a fake `TimekprTransport`-style SSH stub.
- `api/clients/health-dtos` — mappers + schema round-trips.
- `api/clients/health-service` — assembly with/without prober, queue split,
  lastSeen bump on reachable.
- `api/clients/health-routes` — `app.inject()` 401 guard, list, by-id 404,
  degraded `unknown` shape, queue surfacing.

## Deferred (tracked follow-ups, linked from PR)

- Admin "Clients" page UI + enrol-a-client flow — blocked on `/admin/*` shell
  (#53). New follow-up issue.
- Live SSH prober wiring (credentials from `/data/secrets/ssh`) — #39.
- Per-user component probes (aw-server loopback, `pct-client-agent`) — Phase 5 /
  8b.
