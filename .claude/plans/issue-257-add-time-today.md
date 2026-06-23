# Issue #257 — Admin "Add time today" (same-day `timekpra` adjustment)

Roadmap: `docs/roadmap.md` → **Phase 4** (SSH + `timekpra` transport).
Epic: #185 (Alpha-1 readiness), folded-in decision #2 — the pre-Grant-ledger
"give Alice 30 more minutes right now" lever.

## Goal

A manual admin action — `/api` route + `timekpra` transport op + an admin-UI
button — that adjusts a supervised user's **remaining time for _today_** on the
client(s) they're linked to, **without** changing the standing daily `Budget`.

## Key design decision — online-only, NOT offline-queued

The issue text says "routed through … the offline queue (#161)". I am
**deliberately diverging** and applying online-only, because:

- The offline queue (#84) is **at-least-once with coalescing**, and its
  `drainer.ts` contract explicitly requires **idempotent** executors. The
  standing policy push is idempotent (re-resolve effective policy → set
  _absolute_ limits). An additive `--settimeleft +N` is **not** idempotent:
  a crash-then-replay would double-apply, and coalescing two queued `+15`s
  (latest-wins) would silently drop one. Both are correctness bugs.
- This lever is an **ephemeral same-day** nudge that "does not persist past the
  daily rollover" (issue text) — a change queued against an offline client is
  likely moot by the time the client reconnects.

So: apply **synchronously** to each reachable linked client; report a per-client
`unreachable` outcome for offline ones (no enqueue). The transport command is
still **audited** (#85) on every path. Documented in `docs/architecture.md`;
divergence flagged on the issue + PR. A queue-safe (absolute-target) variant can
be a later follow-up if wanted.

Also distinct from the existing push: this is an **awaitable** operation that
returns a result to the admin, not the fire-and-forget `PolicyPushStub.push`.

## Timekpr grammar

`timekpra --settimeleft USER OPERATION SECONDS`, `OPERATION ∈ {+,-,=}`
(verified against upstream `timekpra` admin CLI docs; ISO/seconds conventions as
the other builders use). `+`/`-` adjust today's remaining time; `=` sets it.

## Phases

### Phase 1 — Transport (pure + client method)
- `transport/timekpr/commands.ts`: `TimeLeftOperation` type (`"+"|"-"|"="`),
  `buildSetTimeLeft(username, op, seconds)` → `["--settimeleft", username, op,
  String(seconds)]`, with `assertUsername` + `assertSeconds` + op validation.
- `transport/timekpr/client.ts`: `setTimeLeft(op, seconds)` via `#exec`.
- Re-export `TimeLeftOperation` / `buildSetTimeLeft` from `timekpr/index.ts`.
- Tests: `tests/transport/timekpr/commands.test.ts` (new cases),
  `tests/transport/timekpr/client.test.ts` (new case).

### Phase 2 — Adjustment service + live wiring
- `transport/time-today/adjust.ts`:
  - `TimeTodayClient` (structural: `setTimeLeft`), `TimeTodayClientFactory`.
  - `TimeTodayAdjustment` (`userId`, `operation`, `seconds`, optional `clientId`).
  - `ClientAdjustmentResult` (`clientId`, `osUsername`, `status:
    applied|unreachable|failed`, optional `error`).
  - `adjustTimeToday(db, buildClient, adjustment)` — resolves the user's links
    (optionally filtered to `clientId`), runs `setTimeLeft` per client, maps the
    SSH taxonomy via `isRetriable` → `unreachable` vs `failed`. Pure of HTTP.
- `transport/policy-push/bootstrap.ts`: in **live** mode add
  `adjustTimeToday` to the returned `PolicyPushTransport`, built from the same
  audited SSH `TimekprClient` factory (context `actor:"admin"`,
  `reason:"time.adjusted"`). In **fallback** mode (no SSH key) leave it
  `undefined` (mirrors how `policyPush` is optional) so the route returns 503.
- `transport/policy-push/index.ts`: export the new types.
- Tests: `tests/transport/time-today/adjust.test.ts`; extend
  `tests/transport/policy-push/bootstrap.test.ts` for live-vs-fallback presence.

### Phase 3 — API route
- `api/policy/dtos.ts`: `adjustTimeTodaySchema` (refine: exactly one of
  `deltaSeconds` (int, non-zero, bounded ±86400) / `setSeconds` (int 0..86400);
  optional `clientId` positive int) + `timeTodayResponseSchema` +
  `toTimeTodayResponse`. Re-export from `api/policy/index.ts` and the `api/`
  barrel.
- `api/policy/time-today.ts`: `registerTimeTodayRoutes(scope, adjuster?)` —
  `POST /users/:userId/time-today`, admin-guarded; 404 unknown user; 404 when a
  given `clientId` isn't linked; 409 `no_linked_clients` when the user has no
  links; 503 `transport_unavailable` when `adjuster` is absent. Maps delta sign
  → `+`/`-`, `setSeconds` → `=`.
- `api/plugin.ts` + `web/app.ts`: thread `policyPush.adjustTimeToday` through.
- Tests: `tests/api/time-today.test.ts` (app.inject: 401/404/409/503/200 +
  per-client result shape + delta/set mapping + validation).

### Phase 4 — Admin UI
- `frontend/src/lib/api/time-today.ts`: `adjustTimeToday(userId, body)` wrapper.
- `frontend/src/lib/api/contract.ts`: re-export the two DTO types.
- `LinksView.svelte`: per-user "Add time today" control (`+15` / `+30` / custom
  minutes, optional per-client) with the **not-a-Grant** caveat, surfacing the
  per-client applied/unreachable/failed result. Online-only is honest in copy.
- Test: `frontend/tests/components/links-view-time-today.test.ts`.

## License boundary

None touched — still exec-over-SSH of `timekpra` (GPL) as a subprocess via the
existing facade; no in-process linkage, no GPL binary in the image, no new
dependency, no transport/REST boundary collapsed. UI `/api` stays type-only.

## Out of scope (tracked elsewhere)
- Grant ledger / additive auditable overlay + integrator grants — Phase 10.
- `lockout.cleared` event / "you can log back in" toast — Phase 8b/8c.
- Queue-safe (absolute-target) offline variant — follow-up issue if wanted.
