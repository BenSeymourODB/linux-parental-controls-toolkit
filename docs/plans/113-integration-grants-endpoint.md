# Plan — `POST /api/integrations/grants` (v1 grant endpoint) — #113 (+ #118 contract ADR)

Roadmap: `docs/roadmap.md` → Phase 10 (first bullet + idempotency).
Design: `docs/architecture.md` → "External integrations"; new ADR 0014.

## Goal

The inbound grant endpoint that external integrators (first
next-digital-wall-calendar, "NDWC") call to grant screen-time rewards. Records
an immutable, additive `Grant` row, idempotent by the integrator-supplied
`source_ref`. Scope is deliberately **record + dedupe only** — emitting
`grant.applied` and recomputing/pushing the effective budget is #117; per-token
rate limiting is #115; the ledger admin UI is #116.

## Prerequisite decision (#118) — pinned in ADR 0014

#113 is gated by #118 ("agree the v1 request/response contract"). The one part
that is a genuine unresolved decision (not already fixed by the schema) is the
**`user_ref` mapping**: `User` has only `id` + `displayName` today — no stable
human slug. ADR 0014 pins:

- **`user_ref`** — the dashboard `User.id` in **decimal-string** form for v1.
  Typed as a JSON `string` (not a number) so a later release can also accept a
  human-assigned alias without a `v2` (forward-compatible widening). Resolved to
  a `User`; unknown ⇒ `404`.
- **Wire casing** — **snake_case** (`user_ref`, `source_ref`, `expires_at`),
  matching the `docs/architecture.md` example verbatim. This is the deliberate
  external-integration convention, distinct from the internal camelCase `/api`
  DTOs; the route maps snake_case → camelCase repository input at the boundary.
- **`scope` / `target`** — `overall` (no `target`), `activity` (`target` =
  `activities.id`), `group` (`target` = `activityGroups.id`). `target` is
  required for activity/group, forbidden for overall, and must resolve to an
  existing row (`404` otherwise). Completes the architecture example, which only
  showed the `overall` case.
- **`seconds`** — integer > 0.
- **`expires_at`** — ISO-8601 datetime; must be in the future at request time.
- **`source_ref`** — required non-empty string; the idempotency key
  (`UNIQUE(source_ref)` already on the table). A replay with a seen `source_ref`
  returns the **existing** grant with `200` (no new row); a first sighting
  creates it with `201`.
- **`reason`** — optional free text.
- **`source`** — stamped server-side as `integration:<token-name>` (the
  authenticated token's name), never client-supplied. Satisfies the table's
  `source` CHECK.
- **Errors** — `400` validation / bad target coherence, `401` missing/invalid
  token, `403` token lacking `grants:write`, `404` unknown `user_ref`/`target`.

The ADR is explicit that this is the **dashboard-side v1 proposal, pending
confirmation with NDWC**; the versioned path + idempotency make it safe to
evolve.

## Phases

### Phase 1 — repository + ADR
- `docs/adr/0014-integration-grant-contract-v1.md` (above).
- `server/src/policy/grants.ts`:
  - `GrantRow` re-export / `NewGrant` input type.
  - `createGrant(db, input)` — insert, return row.
  - `findGrantBySourceRef(db, sourceRef)` — for idempotent replay.
  - Export from `policy/index.ts`.
- Tests: `server/tests/policy/grants.test.ts` (insert round-trip, source_ref
  lookup, unique-violation surfaces, overall/activity/group coherence).

### Phase 2 — DTOs + route + wiring
- `server/src/api/integrations/grant-dtos.ts` — snake_case zod request +
  response schemas; inferred types.
- `server/src/api/integrations/grants-routes.ts` —
  `registerIntegrationGrantRoutes(scope)`: `POST /integrations/grants` behind
  `scope.requireIntegrationToken("grants:write")`; resolve `user_ref`, validate
  `target`, idempotent create keyed on `source_ref` (catch unique-violation race
  → return existing), stamp `source`, serialise dates.
- Register from `api/plugin.ts` (after `registerIntegrationRoutes`, which
  decorates `requireIntegrationToken`).
- Re-export DTO types from `api/integrations/index.ts`.
- Tests: `server/tests/api/integrations/grants-routes.test.ts` — anonymous
  `401`; wrong-scope token `403`; happy overall/activity/group `201`; idempotent
  replay `200` + no second row; `400` on past `expires_at`, bad target coherence,
  `seconds <= 0`; `404` on unknown user / target; `source` stamped from token.

## License boundary

N/A — pure TypeScript + zod + Drizzle over the policy store. No subprocess /
REST / GPL boundary; no packaging or Docker-image change.

## Out of scope (deferred, tracked)

- `grant.applied` event + effective-budget recompute + SSH push → #117.
- Per-token rate limiting → #115.
- Grant-ledger admin UI (view / filter / revoke) → #116.
