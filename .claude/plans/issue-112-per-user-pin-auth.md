# Plan — #112 Per-user PIN/passcode auth model for child users on `/app`

Roadmap: `docs/roadmap.md` → **Phase 9** ("an additional lightweight per-user
PIN/passcode model for child users who should only see their own data").

## Goal

A lightweight, child-scoped auth model so a supervised `User` can open `/app`,
authenticate with a per-user PIN, and see **only their own** data — distinct
from the single admin/parent session (#52) that the admin UI uses. This PR
delivers the **model + a safe scoping mechanism**, not every per-screen route
(those ride with #110/#111).

## Hard constraints

- **Deny-by-default scoping.** A PIN session reaches only routes that *opt in*
  via the new `requirePinSession` guard. Every existing route stays admin-only
  and ignores the PIN cookie. So incomplete per-screen coverage can never leak
  another user's data — an un-opted route simply rejects a PIN session.
- **Two separate paths.** Keep the Phase-12 "My Time" Linux-session path
  (`linux-uid → User`, ADR 0002) out of scope; this is the browser PIN path.
- **No new auth framework.** Reuse the existing `argon2` hashing
  (`auth/passwords.ts`), `@fastify/cookie` signing pattern (`auth/session.ts`),
  and `FixedWindowRateLimiter` (`auth/rate-limit.ts`). The doc's Better-auth
  note is for the *later* multi-admin/OIDC work (#121), not this.
- License boundary: none touched (TypeScript + argon2/MIT + cookie/MIT +
  Drizzle). No GPL, no transport/packaging change.

## Design decisions

- **Credential storage: a separate `user_pins` table** (not a column on
  `users`). A PIN hash is a credential that must never ride along in a `User`
  DTO; isolating it in its own table means a careless `select()` on `users`
  can never serialise it. One row per user (`user_id` UNIQUE, FK → `users.id`
  `ON DELETE CASCADE`), `hashed_pin`, `created_at`/`updated_at`.
- **PIN session cookie** `pct_pin_session`, signed with `PCT_SECRET_KEY` like
  the admin cookie, `HttpOnly` + `SameSite=Strict`, payload `{ uid, iat }`.
  Shorter TTL than the admin's week — **12 h** (a shared child device should
  re-auth daily). Expiry enforced both by `maxAge` and an `iat` age check.
- **Login by `userId` + PIN.** A friendly name/avatar picker is a #110/#111
  concern and would otherwise require an unauthenticated household-roster
  endpoint (a disclosure we will not add here). The `/app` login form takes the
  user's id + PIN.
- **PIN format:** 4–10 digits (numeric passcode). Validated by the zod DTO.
- **Anti-enumeration + lockout:** unknown/PIN-less user still runs a dummy
  verify (timing parity, `verifyDummy`); a dedicated `FixedWindowRateLimiter`
  keyed by `userId` locks out after N failed attempts (429).

## Phases

### Phase 1 — store + credential model
- `policy/schema.ts`: `userPins` table (+ FK/unique/index). `npm run db:generate`
  → commit the timestamped migration.
- `policy/user-pins.ts`: `getUserPinHash`, `setUserPin` (upsert), `clearUserPin`
  (→ bool), `hasUserPin`.
- Tests: `tests/policy/user-pins.test.ts` (set/upsert/get/clear/has + cascade on
  user delete).

### Phase 2 — session, guard, management + `/app` API
- `auth/pin-session.ts`: `issuePinSession` / `clearPinSession` / `readPinSession`
  (mirror `session.ts`; `PIN_SESSION_COOKIE`, `PIN_SESSION_TTL_SECONDS`).
- `auth/pin-guard.ts`: `makeRequirePinSession(authConfigured)` → decorates
  `app.requirePinSession` + `request.pinUser`. Wire decoration in `registerAuth`.
- `api/app/dtos.ts`: `pinLoginSchema` (`{ userId, pin }`), `appSessionResponse`
  (`{ authenticated, user? }`), `setPinSchema` (`{ pin }`), `pinStatusResponse`
  (`{ pinSet }`). Re-export inferred types from `api/index.ts`.
- `api/app/routes.ts`: `POST/DELETE/GET /api/app/session`, `GET /api/app/me`
  (first deny-by-default own-data read). Per-user lockout limiter.
- `api/users/pin.ts` (admin-guarded): `PUT /api/users/:userId/pin`,
  `DELETE /api/users/:userId/pin`, `GET /api/users/:userId/pin` (→ `{ pinSet }`).
- Wire both into `api/plugin.ts` after `registerAuth`.
- Tests: `tests/auth/pin-session.test.ts`, `tests/api/app-session.test.ts`,
  `tests/api/users-pin.test.ts` (admin-guard, validation, login success/wrong/
  unknown/lockout, scoped `me`, logout).

### Phase 3 — `/app` login UI + docs
- `frontend/src/lib/api/app-session.ts` typed client over the DTOs.
- `/app` shell: PIN-entry login when unauthenticated; show signed-in user + a
  sign-out on `+page`. Minimal, mobile-first; friendly picker deferred to #110.
- `frontend` component/api smoke test mirroring existing `*-view` tests.
- `docs/server-deployment.md` → Authentication: add a "Per-user PIN sessions
  (child `/app`)" subsection (scoped, deny-by-default, separate from admin).
- `cd server/frontend && npm run build` (CI parity).

## Out of scope (tracked elsewhere)
- Per-screen status payload + the broader scoped route set → **#110 / #111**
  (they render into this model and opt their own reads into the guard).
- Friendly user picker / avatars on the `/app` login → #110/#111.
- Linux-session client auth → Phase 12 / ADR 0002.
