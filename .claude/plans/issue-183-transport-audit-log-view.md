# Plan — #183 Admin UI: transport audit log view (`/admin`)

Phase 4 (`docs/roadmap.md` → "Audit log of every command issued"). The UI half
of #85; the backend (`audit_log` table + recorder + `AuditingTransport`) and the
`GET /api/audit` read API already landed. **Frontend-only** work.

## Backend contract (already shipped — do not change unless a field is missing)

`GET /api/audit` (`server/src/api/audit/`), behind `requireAdmin`:

- Query (`listAuditQuerySchema`): `clientId?` (int), `outcome?`
  (`ok|failed|unreachable|timeout|parse_error`), `before?` (id cursor),
  `limit?` (1..200, default 50).
- Response (`auditListResponseSchema`): `{ entries: AuditEntryResponse[],
  nextCursor: number | null }`. `nextCursor` is the last (oldest) entry id when
  a full page came back, else `null` (end of log).
- `AuditEntryResponse`: `id, at (ISO string), targetHost, targetPort,
  targetUser, clientId|null, userId|null, actor, reason|null, command (string[]),
  outcome, exitCode|null, signal|null, durationMs, errorMessage|null`.

Entries are newest-first; pagination walks backward via `before = nextCursor`.

## Frontend patterns to mirror (all under `server/frontend/`)

- API wrappers: `src/lib/api/*.ts` — thin typed `apiFetch` wrappers, types only
  from `src/lib/api/contract.ts` (which re-exports inferred zod types from the
  server `/api` source; **never re-declare a DTO**).
- Views: `src/lib/views/*View.svelte` — Svelte 5 runes (`$state`, `$derived`,
  `onMount`), browser-guarded loads, inline error surface via `messageOf`.
- Orchestrator: `src/routes/admin/+page.svelte` owns `navItems` + the view
  switch; `AppShell` renders the sidebar nav.
- Tests: `tests/api/*.test.ts` — vitest, `fetch` spied with a `jsonResponse`
  helper. **No Svelte component-test harness exists** and the guide says not to
  stand one up for an unrelated ticket, so test the API wrapper, not the view.

## Phase 1 — API client + contract re-exports + test

1. `src/lib/api/contract.ts`: add `AuditEntryResponse`, `AuditListResponse`
   (from `../../../../src/api/audit/dtos.js`) and `AuditOutcome` (from
   `../../../../src/policy/enums.js`).
2. `src/lib/api/audit.ts`: `listAudit(params)` building a querystring from the
   optional `clientId` / `outcome` / `before` / `limit`, returning
   `AuditListResponse`. Read-only — no create/update/delete.
3. `tests/api/audit.test.ts`: assert the URL + querystring assembly (no params,
   each filter, cursor) and that it GETs and returns the parsed body.

## Phase 2 — `AuditLogView.svelte` + nav wiring

4. `src/lib/views/AuditLogView.svelte`:
   - Loads the first page on mount (browser-guarded).
   - Table newest-first: `at` (short local), `actor`, target `host`/`user`,
     `command` (joined argv), `outcome` (status-styled chip), `exitCode`/
     `signal`, `durationMs`, `reason`/`errorMessage`.
   - Filters: `clientId` (numeric input) + `outcome` (select over
     `auditOutcomeValues`); changing a filter resets and reloads from the top.
   - "Load older" button shown while `nextCursor !== null`; appends the next
     page using `before = nextCursor`.
   - Inline `error` surface; `loading` state; empty state.
5. `src/routes/admin/+page.svelte`: add `{ id: "audit", label: "Audit log" }` to
   `navItems` and an `{:else if activeView === "audit"}<AuditLogView />` branch.

## Validation

- Frontend: `npm run check` (svelte-check), `npm run test` (vitest),
  `npm run build` (svelte-kit sync && vite build) — must succeed (CI mirrors the
  `frontend-build` job, which installs the server package first).
- Server: full gate from `server/` (`format:check`, `lint`, `typecheck`, `test`)
  — unaffected (no `server/src` change) but run to confirm no regression.

## License boundary

N/A — frontend consumes the existing JSON `/api` only; contract re-exports are
`import type` (erased at build, no runtime/GPL coupling). No transport or
packaging change.

## Deferred / out of scope (tracked separately)

- Surfacing the audit view from the per-client detail / Clients page (#183 notes
  "surface it from #81"): the Clients health/detail page is itself #81/#194 and
  not yet built, so a deep-link from there is deferred to that work. This view is
  reachable from the top-level admin nav and supports a `clientId` filter, which
  satisfies "what did the system do to this client" today.
