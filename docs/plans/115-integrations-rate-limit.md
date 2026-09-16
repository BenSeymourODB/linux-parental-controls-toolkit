# Plan: Per-token rate limiting on `/api/integrations/*` (#115)

Roadmap: `docs/roadmap.md` → Phase 10 ("rate limiting per token").
Design: `docs/architecture.md` → "External integrations" (per-integration
tokens are "scoped, revocable, rate-limited").

## Problem

A noisy or misbehaving external integrator (the family-calendar rewards system,
etc.) authenticating on `/api/integrations/*` can flood the single-process
dashboard. `CLAUDE.md` and `docs/architecture.md` both require per-integration
tokens to be **rate-limited**; the token model (#114), the
`requireIntegrationToken` guard, and the scope vocabulary already exist on
`main`, but nothing throttles a token's request rate yet.

## Why this is independent of the grant endpoint (#113 / PR #422)

Rate limiting lives in the **guard** (`integrations/guard.ts`), applied the
moment a token authenticates — not in any one route handler. It therefore
protects the (future) grants endpoint and every other integration endpoint
automatically, and needs only the guard, which is already on `main`.

## Design decisions

1. **Request-count, not failed-attempt.** `auth/rate-limit.ts` is a
   *failed-attempt* limiter (records failures, clears on success) for login /
   enrol throttling. Per-token API throttling needs a *request-count* fixed
   window: every authenticated request counts. These are different semantics,
   so a small dedicated limiter (`integrations/rate-limit.ts`) is the right
   move rather than overloading the auth one. No new dependency — same
   rationale the `auth/rate-limit.ts` docstring already records for not pulling
   in `@fastify/rate-limit`.

2. **Keyed by token id.** "Per token" per the issue — so one integrator's
   burst never starves another's budget. The guard resolves
   `request.integration.id` on authentication; that is the key.

3. **Checked after authentication, before the scope check.** An unauthenticated
   request is `401` before any token is known (it must not consume a token's
   budget). A token spamming with the wrong scope still counts against its
   limit — so the check sits between `authenticateIntegrationToken` and the
   scope test.

4. **Standard envelope + metadata headers.** Over-limit → `ApiError(429,
   "rate_limited", …)` rendered as the shared `{ error: { code, message } }`
   envelope. Set `Retry-After` (seconds) and the IETF-draft `RateLimit-Limit` /
   `RateLimit-Remaining` / `RateLimit-Reset` headers on both the throttled
   response and admitted responses ("surface limit metadata if practical").

5. **Config seam** mirroring `telemetry` / `clientHealth`:
   `PCT_INTEGRATIONS_RATE_LIMIT_MAX` (default 120) and
   `PCT_INTEGRATIONS_RATE_LIMIT_WINDOW_SECONDS` (default 60) → one request per
   ~0.5 s sustained, generous for webhook-driven grants while cutting off a
   runaway loop. A single long-lived limiter instance is created in
   `registerIntegrationRoutes` and closed over by the guard (in-process memory,
   one process — same posture as `auth/rate-limit.ts`).

## Phases

### Phase 1 — limiter core + config + unit tests
- `server/src/integrations/rate-limit.ts`: `FixedWindowQuota` class with an
  injectable clock; `consume(key) → { limited, limit, remaining, resetAtMs,
  retryAfterMs }`. Lazy prune of elapsed windows on access.
- `server/src/config.ts`: `integrations.rateLimit.{maxRequests, windowSeconds}`
  block + `PCT_INTEGRATIONS_RATE_LIMIT_*` wiring.
- Unit tests: window fill/reset, per-key isolation, metadata maths, disabled
  (`max = 0` → never limits, opt-out) if we support it.

### Phase 2 — guard wiring + headers + integration tests + docs
- `integrations/guard.ts`: `makeRequireIntegrationToken(db, rateLimiter?)` — the
  limiter is optional so existing callers/tests keep working; when present, the
  guard consumes a slot post-auth, sets `RateLimit-*` headers, and throws `429`
  when limited.
- `api/integrations/routes.ts`: build the limiter from settings and pass it into
  the guard factory. Thread `settings` into `registerIntegrationRoutes` and the
  `apiPlugin` call.
- Tests: guard integration test (429 after N requests within the window; headers
  present; per-token isolation; a fresh window admits again via an injected
  clock).
- Docs: `docs/architecture.md` / `docs/server-deployment.md` note the config
  knobs and the 429 contract.

## Out of scope (not this PR)

- Distributed / cross-process limiting (single process by design).
- Per-scope or per-endpoint differentiated limits (one bucket per token for
  now; revisit if a real integrator needs burst vs. sustained tiers).

## License boundary

None touched — plain TypeScript + Fastify + `node`'s own clock. No GPL linkage,
no GPL binary added to the image.
