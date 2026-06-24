# Plan — #112 Per-user PIN/passcode auth model for child users on `/app`

Roadmap: `docs/roadmap.md` → Phase 9 ("an additional lightweight per-user
PIN/passcode model for child users who should only see their own data").

## Goal (this PR's slice)

Deliver the **per-user PIN auth model** and a **safe, deny-by-default scoping
mechanism** end-to-end:

1. A hashed per-user PIN credential in the policy store (Argon2id, reusing
   `auth/passwords.ts`).
2. A **child-scoped session** distinct from the admin session — its own signed
   cookie — plus a `requirePinSession` guard exposing the authenticated
   `userId`, and a per-user failed-attempt lockout (reusing
   `auth/rate-limit.ts`).
3. Admin management to set/reset/clear a user's PIN from `/admin`.
4. The `/app` PIN login + logout + whoami, and a first own-data-only read
   (`GET /api/app/me`) proving the model works.
5. A minimal `/app` PIN-entry login screen rendering into the existing `#109`
   app shell.

## Safety design — deny-by-default

PIN sessions are **not** "everything except admin." A PIN session only reaches
routes that explicitly opt in via `requirePinSession`; every existing route
keeps `requireAdmin` and rejects a PIN session. So future screens (#110/#111)
attach their own own-data reads behind the established guard, and an
un-migrated route can never leak another user's data.

The PIN session carries only `{ uid, iat }`. Each scoped handler reads
`request.pinUser.userId` and serves **only** that user's rows — never a
caller-supplied id.

## Key decisions

- **Separate `user_pins` table** (not a `users` column) so the hash never rides
  along on the widely-read `users` rows / DTOs. Keyed by `user_id` (unique, FK
  → `users.id`, `ON DELETE CASCADE`). Mirrors the `integration_tokens`
  credential-isolation precedent.
- **Login by `userId` + PIN.** The `/app` login posts `{ userId, pin }`. No
  unauthenticated household-roster endpoint (would disclose the user list); the
  friendly name/avatar picker is explicitly **#110/#111**'s job. Unknown-userId
  path runs a dummy verify (timing parity, mirrors admin login).
- **PIN format:** 4–10 digits (numeric passcode), validated by zod. Stored only
  as an Argon2id hash; plaintext never persisted or logged.
- **Cookie:** `pct_pin_session`, `HttpOnly`, `SameSite=Strict`, signed with
  `PCT_SECRET_KEY`, `path=/`. TTL 12h (a child device re-auths daily; shorter
  than the 7-day admin session). Fails closed (503) when `PCT_SECRET_KEY` unset.
- **Lockout:** `FixedWindowRateLimiter` keyed by `userId`, dedicated instance.
- Keep the Phase-12 "My Time" Linux-session path (`linux-uid → User`, ADR 0002)
  **separate** from this PIN path (issue note).

## Phases

- **Phase 1 — store + credential model.** `user_pins` schema + generated
  migration; `policy/user-pins.ts` (`setUserPin`/`clearUserPin`/
  `getUserPinHash`/`hasUserPin`); unit tests (incl. cascade-on-user-delete).
- **Phase 2 — session + guard + API.** `auth/pin-session.ts`,
  `auth/pin-guard.ts`; admin `PUT/DELETE/GET /api/users/:userId/pin`;
  `/api/app/` session (`POST`/`DELETE`/`GET /api/app/session`) + `GET
  /api/app/me`; wire into `api/plugin.ts`; DTO re-exports from `api/index.ts`;
  unit + API tests (login ok/wrong/unknown/lockout, scoping, admin-guard,
  validation).
- **Phase 3 — `/app` login UI + docs.** Minimal PIN login in the `/app` shell +
  `$lib/api` client + component test; extend `docs/server-deployment.md` →
  Authentication with the child-PIN session. Build the frontend (CI parity).

## Deferred (tracked)

- Full per-screen status payload + the broader scoped route set → **#110**
  (per-child status) / **#111** (parent home). This PR establishes the model +
  guard they consume.
- Friendly user picker on `/app` login → #110/#111.

## Test gate (per phase, from `server/`)

`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test` (≥80%).
Phase 3 also `cd server/frontend && npm run build`.

## License boundary

None touched — `argon2` (MIT) + `@fastify/cookie` (MIT) + Drizzle, all already
in-process. No GPL linkage, no GPL binary, no transport/packaging change. **No
new dependency.**
