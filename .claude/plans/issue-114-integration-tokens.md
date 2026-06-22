# Issue #114 — IntegrationToken issuance / scoping / revocation (backend slice)

Phase 10. Per-integration API tokens: scoped, revocable, hashed-at-rest, with
an auth guard for `/api/integrations/*`. This plan delivers the **backend
slice** end-to-end; the admin UI management page is split to a follow-up issue
(precedent: #81 backend → #194 frontend).

## Why this is unblocked & clean

- The `integration_tokens` table already exists on `main`
  (`name`, `scopes[]` JSON, `hashed_secret`, `created_at`, `last_used_at`,
  `revoked_at`, unique-name index) — **no migration needed**.
- `auth/secret-token.ts` already provides `generateToken` / `hashToken`
  (SHA-256, lookup-by-hash) and its docstring explicitly anticipates the
  `integration_tokens` secret reusing it.
- Mirrors the enrolment-token precedent (#77): admin mints a token, plaintext
  shown once, only the hash persisted; a separate bearer-authenticated surface
  validates by hash lookup.
- No GPL/license-boundary or tamper-resistance surface — pure first-party auth.

## Contract (grounded in `docs/architecture.md` → "External integrations")

- Scopes: `grants:write`, `policy:read` (the two the doc names).
- All inbound external traffic enters via `/api/integrations/*`, bearer-token
  auth, per-integration scoped + revocable tokens.

## Files

### Domain / vocabulary
1. **`server/src/integrations/scopes.ts`** (new) — `INTEGRATION_SCOPES`
   readonly tuple, `IntegrationScope` type. The canonical scope vocabulary.

### Data access (mirrors `policy/enrolment.ts`)
2. **`server/src/policy/integration-tokens.ts`** (new) — synchronous Drizzle
   access over `integration_tokens`:
   - `createIntegrationToken(db, {name, scopes, hashedSecret}) -> row`
   - `listIntegrationTokens(db) -> rows` (ordered by id asc)
   - `getIntegrationToken(db, id) -> row | undefined`
   - `findIntegrationTokenByHash(db, hash) -> row | undefined`
   - `revokeIntegrationToken(db, id) -> row | undefined` (sets `revoked_at`
     iff currently null; returns the current row, `undefined` if no such id)
   - `touchIntegrationTokenLastUsed(db, id)` (sets `last_used_at = now`)
   - reuse `repo.isUniqueViolation` for the unique-name conflict.

### Service (lifecycle + auth resolution)
3. **`server/src/integrations/tokens.ts`** (new):
   - `issueIntegrationToken(db, {name, scopes}) -> {id, name, scopes, secret, createdAt}`
     — `generateToken` + `hashToken` + persist; unique-name → `ApiError(409)`.
   - `listIntegrationTokenSummaries(db) -> Summary[]` (never includes the hash).
   - `revokeIntegrationToken(db, id) -> Summary` — `404` if missing; idempotent
     if already revoked (returns the current row).
   - `authenticateIntegrationToken(db, secret) -> {id, name, scopes}` — hash +
     lookup; `401` if unknown or revoked; touches `last_used_at` on success.

### Guard
4. **`server/src/integrations/guard.ts`** (new) — `makeRequireIntegrationToken(db)`
   returns a factory `(...required: IntegrationScope[]) => preHandlerHookHandler`
   that parses `Authorization: Bearer …` (reusing `parseBearer` from
   `api/clients/routes.ts`), calls `authenticateIntegrationToken`, sets
   `request.integration = {id, name, scopes}`, and enforces that the token
   carries every `required` scope (`403 insufficient_scope` otherwise).
   Fastify module augmentation adds `request.integration` and
   `app.requireIntegrationToken`. Decorated in `registerIntegrationRoutes`.

### API DTOs + routes
5. **`server/src/api/integrations/dtos.ts`** (new) — zod: `integrationScopeSchema`
   (`z.enum` from `INTEGRATION_SCOPES`), `createIntegrationTokenSchema`
   (`name` 1..64 trimmed, `scopes` min-1 distinct), `integrationTokenCreatedSchema`
   (`{id,name,scopes,secret,createdAt}` — secret shown once),
   `integrationTokenSummarySchema` (`{id,name,scopes,createdAt,lastUsedAt?,revokedAt?}`),
   list = array of summary, revoke = summary.
6. **`server/src/api/integrations/routes.ts`** (new) —
   `registerIntegrationRoutes(scope)`:
   - decorates `scope.requireIntegrationToken` (ready for #113);
   - `POST /integrations/tokens` (`requireAdmin`) → 201, secret once;
   - `GET /integrations/tokens` (`requireAdmin`) → summaries;
   - `POST /integrations/tokens/:id/revoke` (`requireAdmin`) → revoked summary.
7. **`server/src/api/integrations/index.ts`** (new) — re-export
   `registerIntegrationRoutes` + the DTO types.
8. **`server/src/api/plugin.ts`** — call `registerIntegrationRoutes(scope)`
   after `registerAuth` (so `requireAdmin` exists).

## Tests
- `tests/policy/integration-tokens.test.ts` — repo CRUD + unique-name violation.
- `tests/integrations/tokens.test.ts` — service: issue (hash stored not
  plaintext), list excludes secret, revoke (404 / idempotent), authenticate
  (valid / unknown→401 / revoked→401 / touches last_used_at).
- `tests/integrations/guard.test.ts` — guard on a throwaway Fastify probe route:
  missing/malformed/unknown/revoked → 401, missing scope → 403, valid sets
  `request.integration` → 200.
- `tests/api/integrations/routes.test.ts` — admin routes via `buildTestApp` +
  `inject` with a login cookie: mint (201 + secret), list (no secret), revoke
  (then the token auths 401), `requireAdmin` (401 anon), bad scope (400),
  duplicate name (409).

## Deferred (file + link follow-up)
- Admin UI token-management page (`design/admin/integrations.html`).
- Per-token rate limiting on `/api/integrations/*` is already its own issue #115.

## License-boundary note
Pure TypeScript + `node:crypto` (via `auth/secret-token.ts`) + zod + Drizzle. No
GPL linkage, no GPL binary, no subprocess/REST boundary. No new dependency.
`license-guard` unaffected.
