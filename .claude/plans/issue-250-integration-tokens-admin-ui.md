# Issue #250 — Admin UI: integration tokens management page

Phase 10. The **frontend half of #114** (backend merged to `main`). Pure
frontend work mirroring the established `$lib/api` + `*View.svelte` patterns;
no server code, no new license surface (`CLAUDE.md` → "Read + mint + revoke
only").

## Backend it consumes (already on `main`, #114)

- `POST /api/integrations/tokens` — mint (admin-guarded), returns plaintext
  `secret` **once** (`integrationTokenCreatedSchema`).
- `GET /api/integrations/tokens` — list summaries (`integrationTokenSummarySchema`,
  never the secret).
- `POST /api/integrations/tokens/:id/revoke` — revoke (idempotent), returns the
  updated summary.
- DTOs in `server/src/api/integrations/dtos.ts`; scope vocabulary
  `INTEGRATION_SCOPES = ["grants:write", "policy:read"]` in
  `server/src/integrations/scopes.ts`.

## Scope (frontend only)

1. **Contract surface** — extend `server/frontend/src/lib/api/contract.ts` with
   type-only re-exports of the four integration-token DTO types plus the
   `IntegrationScope` type (the scopes-checkbox UI needs the type to keep its
   runtime option list drift-checked, exactly as `BudgetsView` types
   `WINDOW_OPTIONS` against `BudgetWindow`).
2. **API wrapper** — `server/frontend/src/lib/api/integration-tokens.ts`: thin
   `apiFetch` wrappers `listIntegrationTokens`, `createIntegrationToken`,
   `revokeIntegrationToken`, mirroring `clients.ts`.
3. **View** — `server/frontend/src/lib/views/IntegrationTokensView.svelte`:
   - List tokens: name, scope chips, created / last-used / revoked timestamps,
     and an active/revoked state badge.
   - "Create token" flow: name input + scope checkboxes
     (`grants:write`, `policy:read`, ≥1 required); on success render the
     plaintext `secret` **once** in a highlighted panel with a copy button
     (mirroring `ClientHealthView`'s `navigator.clipboard` + `copied` flag) and
     a clear "you won't see this again" warning. Append the new token (as a
     summary) to the table.
   - Revoke action with `confirm()`; on success swap the row for the returned
     summary (now carrying `revokedAt`) and disable revoke for already-revoked
     tokens. Errors surfaced inline via the shared `role="alert"` pattern.
4. **Wire into the admin shell** — add `{ id: "integrations", label: "Integrations" }`
   to `navItems` and an `{:else if activeView === "integrations"}` branch in
   `routes/admin/+page.svelte`.

### Product decision: the "Rate" column in the mock

`design/admin/integrations.html` shows a per-token rate column. Rate limiting is
**#115** (separate Phase-10 issue) and the summary DTO carries no rate data, so
this slice omits that column. Noted in the PR; tracked by #115.

## Tests

- `tests/api/integration-tokens.test.ts` — mirrors `tests/api/clients.test.ts`:
  list GETs the path, create POSTs the body, revoke POSTs `/…/:id/revoke`.
- `tests/components/integration-tokens-view-crud.test.ts` — mirrors
  `clients-view-crud.test.ts`: renders rows, empty state, create shows the
  secret once + appends the row, revoke after confirm shows the revoked badge,
  revoke declined is a no-op, list error → alert, create error stays inline.

## Gates

From `server/frontend`: `npm run check && npm test && npm run build` (the CI
`frontend-build` job). Pre-commit excludes `server/frontend/` from
prettier/eslint/tsc; match existing formatting by hand. No server code touched,
so the server coverage gate is unaffected.

## Deferred / follow-ups

- Per-token rate display + limiting — **#115**.
- DNS/AdGuard and Notification-defaults cards in the same mock — their own
  phases (7 and 8b); out of scope here.
