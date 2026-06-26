# Plan — #194 Admin UI: Clients health/status page + enrol-a-client flow

**Roadmap:** Phase 3 (client install). Frontend half of #81 (backend landed),
split the same way #183 was split from #85.

## Context (verified on `main`)

Backend is fully in place; this is a pure-frontend slice on the existing
`/admin` SvelteKit shell (#53).

- `GET /api/clients/health` → `ClientHealthResponse[]`,
  `GET /api/clients/:id/health` → `ClientHealthResponse`. Registered in
  `server/src/api/plugin.ts` via `registerClientHealthRoutes`, behind
  `requireAdmin`. Source: `server/src/api/clients/health-routes.ts`,
  `health-service.ts`, `health-dtos.ts`.
- `POST /api/clients/enrolment-tokens` (admin-guarded). Request
  `mintEnrolmentTokenSchema` (`{ supervisedUsers: [{userId, linuxUsername}],
  ttlSeconds?, hostname? }`), response `enrolmentTokenResponseSchema`
  (`{ id, token, expiresAt }`). Source: `server/src/api/clients/dtos.ts`,
  `routes.ts`.
- DTO shapes (`health-dtos.ts`):
  - `clientHealthSchema`: `clientId, hostname, reachability
    (online|offline|unknown), lastSeen (ISO|null), enrolledAt (ISO),
    probedAt (ISO|null), components[], queue`.
  - `componentHealthSchema`: `component (timekpr-next|activitywatch|
    e2guardian|pct-client-bridge|pct-client-agent), status (ok|unhealthy|
    unknown), detail`.
  - `clientQueueSchema`: `pending (int), failed (int), actions[]`.
  - `queuedActionSummarySchema`: `id, kind, coalesceKey, status, attempts,
    lastError (null), enqueuedAt, updatedAt`.
- The DTO does **not** carry supervised-users / IP / distro (those appear in
  the design mock but not the real contract). Render only what the contract
  provides — no invented fields.
- Frontend shell: single prerendered `/admin/+page.svelte` switching views via
  client-side state; `AppShell` nav `items`; typed wrappers in `$lib/api/*`;
  DTO types re-exported type-only through `$lib/api/contract.ts`. Frontend
  has a vitest toolchain (`npm run test`) with API-wrapper tests under
  `server/frontend/tests/api/`.
- Mock: `design/admin/clients.html` — per-client cards with a reachability
  pill, component rows, queued-change callout, and an enrol panel showing the
  `curl … | sudo bash -s -- --enrolment-token … --supervised-user …`
  one-liner (documented in `docs/client-install.md`).

## Design decisions

- **New nav item "Client Health"** → new `ClientHealthView.svelte`, leaving the
  existing `ClientsView` (CRUD editor from #189) untouched. The two surfaces
  are distinct concerns; consolidation is a possible follow-up, noted in the
  PR. The health view owns the read-only status + the token-mint enrol flow.
- **Component labels** mapped client-side (`timekpr-next` → "Timekpr-nExT",
  etc.); status/reachability → badge classes (ok=green, unhealthy=red/amber,
  unknown/offline=grey/amber). All five components render in catalogue order
  from the per-client `components[]` the API returns.
- **Degraded state:** when `probedAt === null` (no SSH prober yet, #39 plumbs it
  later) reachability/components come back `unknown`; the view shows a small
  "not yet probed" note while still rendering real enrol/queue state.
- **Enrol one-liner** built from `window.location.origin` +
  `/install-client.sh` + the minted token + the supervised usernames, matching
  `docs/client-install.md`. Token shown once with a copy button.
- **Contract types:** add type-only re-exports for the four health DTO types
  and the two enrolment types to `contract.ts`; no DTO is re-declared
  (CLAUDE.md). Component/status/reachability unions are taken from the DTO
  field types, not separately imported.

## Phases

### Phase A — typed API wrappers + contract types (+ tests)
- `contract.ts`: re-export `ClientHealthResponse`, `ComponentHealthDto`,
  `ClientQueueDto`, `QueuedActionSummary` (from `health-dtos.js`) and
  `MintEnrolmentTokenRequest`, `EnrolmentTokenResponse` (from `dtos.js`).
- New `$lib/api/client-health.ts`: `listClientHealth()`,
  `getClientHealth(id)`.
- `$lib/api/clients.ts`: add `mintEnrolmentToken(input)`.
- Tests: `tests/api/client-health.test.ts` and extend
  `tests/api/clients.test.ts` for the mint call — mirror existing style
  (mock `fetch`, assert URL/method/body).

### Phase B — ClientHealthView + nav wiring
- `ClientHealthView.svelte`: load list on mount (browser-guarded), per-client
  card with reachability pill, `lastSeen`/`probedAt`/`enrolledAt`, five
  component badges with detail, queue summary (pending/failed counts +
  expandable per-action rows showing `kind`/`status`/`attempts`/`lastError`),
  empty + error + degraded states, a "Refresh" action.
- Wire nav item `client-health` + view switch in `+page.svelte`.

### Phase C — enrol-a-client flow
- An "Enrol a new client" panel in the health view: pick an existing user
  (from `listUsers()`), enter the Linux username, optional hostname, mint the
  token, render the install one-liner + expiry, copy button, and a "mint
  another" reset. Support ≥1 supervised-user rows (schema requires distinct
  usernames; min 1).

## Quality gate (run from `server/` after each phase)
`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test`
(coverage ≥80%). Frontend: `cd server/frontend && npm ci && npm run build`
and `npm run test` for the API-wrapper tests.

## License boundary
N/A — JSON-API-only frontend code; no GPL imports, no transport/packaging
changes, no Docker image change. Read-only health + token-mint; no new
enforcement, no tamper-resistance surface.

## Deferred (note in PR; file issues if not already tracked)
- Live reachability/component data depends on the SSH prober wiring (#39 — SSH
  key bootstrap merged; prober injection lands with the live transport).
- "Probe now" / "Re-apply config" action buttons from the mock are write
  actions outside #194's read-only scope — not implemented here.
- Consolidating the CRUD `ClientsView` and the health view into one page.
