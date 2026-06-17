# Issue #52 — Single-admin auth (Argon2id) + signed session + first-admin bootstrap

Roadmap: Phase 2. Blocked by #48/#49/#50 (all closed). Unblocks #51 (policy
routes sit behind this guard) and #53 (admin UI login).

## Scope (deliberately minimal — see owner note on #52)

One admin login. The policy-model `User` is a supervised person, **not** an
auth principal. No multi-user framework, no roles/MFA/federation (those are
Phase 11 / stretch #24→#26). Just: Argon2id hash, a signed session cookie
keyed on `PCT_SECRET_KEY`, login/logout/session endpoints, a reusable guard,
and a documented first-admin bootstrap.

## Decisions

- **Storage:** new `admin_credentials` singleton table (`CHECK (id = 1)`), so
  the schema itself guarantees at most one admin. Stores only the Argon2id
  hash. New drizzle migration `0001_*`.
- **Hashing:** `argon2` (Argon2id). Mandated by the issue and already named in
  `docs/server-deployment.md`'s runtime dependency list. No existing dep does
  password hashing.
- **Session:** `@fastify/cookie` signed cookie. Payload is a non-secret
  base64url(JSON) `{ sub, iat }` signed with `PCT_SECRET_KEY` (HMAC via
  cookie-signature). `httpOnly`, `sameSite=strict`, `path=/`. TTL enforced
  both by cookie `maxAge` and an `iat`-age check in the guard. Chosen over
  `@fastify/secure-session` (no payload secrecy needed — the only datum is
  "this is the admin") and over a JWT lib (overkill for one signed marker).
- **Bootstrap:** `PCT_ADMIN_USERNAME` + `PCT_ADMIN_PASSWORD` consumed on first
  run (an `onReady` hook) to seed the admin row, hashed immediately. Idempotent
  (no-op if an admin row already exists). If unset and no admin exists, log a
  warning and leave login disabled until configured. Documented in
  `docs/server-deployment.md` → "Authentication". Standard path for the
  Docker/homelab single-admin target; not contentious, so not split to
  `decision-needed`.
- **Module:** new `server/src/auth/` (per-responsibility, like `transport/*`).
  Auth DTO types are re-exported from `api/index.ts` so the frontend's import
  surface stays `server/src/api`. `CLAUDE.md` module split + `architecture.md`
  updated to document the module.
- **Unconfigured (`PCT_SECRET_KEY` unset):** auth endpoints and the guard
  return `503 auth_not_configured` in the envelope (cannot sign a session
  without the key). Real deployments set the key; tests set it.

## Wiring

- `registerApi(app, settings)` → `apiPlugin(scope, { settings })`.
- Inside `apiPlugin`: `installApiConventions(scope)` → `await
  registerAuth(scope, settings)` → `registerMetaRoute(scope)`.
- `registerAuth` (encapsulated to `/api`): register `@fastify/cookie`,
  `decorate("requireAdmin", …)`, add the `onReady` bootstrap hook, register
  `/auth/login|logout|session` routes. Future #51 policy routes use
  `scope.requireAdmin`.

## Files

- `src/auth/passwords.ts` — `hashPassword` / `verifyPassword` (Argon2id) + a
  constant dummy hash for constant-time-ish unknown-user verification.
- `src/auth/session.ts` — issue/clear/read the signed session cookie; TTL.
- `src/auth/credentials.ts` — `findAdmin`, `bootstrapAdmin`.
- `src/auth/rate-limit.ts` — minimal in-memory per-IP failed-login limiter.
- `src/auth/guard.ts` — `makeRequireAdmin` preHandler + `requireAdmin` augmentation.
- `src/auth/routes.ts` — `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`.
- `src/auth/dtos.ts` — `loginRequestSchema`, `sessionResponseSchema`.
- `src/auth/index.ts` — `registerAuth` orchestrator + barrel.
- `src/policy/schema.ts` (+ migration), `src/config.ts`, `src/api/plugin.ts`,
  `src/api/index.ts`, `src/web/app.ts`, `.env.example`, docs.

## Tests (coverage gate 80%, `include: src/**`)

- `tests/auth/passwords.test.ts` — hash is argon2id; verify true/false; dummy verify false.
- `tests/auth/session.test.ts` — round-trip; tamper rejected; expired rejected.
- `tests/auth/credentials.test.ts` — seeds when empty+env; no-op when admin exists; warns when env missing (testDb).
- `tests/auth/rate-limit.test.ts` — under/over limit; window reset; success resets.
- `tests/api/auth.test.ts` (buildTestApp) — login ok sets cookie; wrong pw/unknown user → 401; missing field → 400;
  guard rejects anon → 401 + allows valid cookie; logout clears; session whoami anon/auth; 429 after N failures; 503 when unconfigured.

## Phases

1. Schema + migration + config + bootstrap/credentials + passwords (+ tests).
2. Session + guard + routes + api wiring + docs (+ tests).
