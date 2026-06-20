# Plan — #119 Reverse-proxy + TLS deployment guide

Roadmap: `docs/roadmap.md` → Phase 11 ("Reverse-proxy + TLS instructions
for non-LAN deployments"). Extends `docs/server-deployment.md`.

## Goal

A self-contained deployment guide for running the dashboard behind a
TLS-terminating reverse proxy, for access beyond a trusted LAN. Provide
copy-pasteable example configs and get the dashboard-specific details
right (the WebSocket event stream, the connectivity model, the
application-layer security caveats).

## Deliverable

New file `docs/reverse-proxy-tls.md`, plus a cross-link added to
`docs/server-deployment.md` (which today only has a two-sentence
"terminate TLS at a reverse proxy" note).

This is a **documentation-only** change: no `server/` source, no tests,
no transport or packaging change, no GPL surface.

## What the guide must cover (from the issue)

1. Guidance + example config (Caddy, nginx, Traefik) terminating TLS in
   front of the Fastify container.
2. Proxying the WebSocket event stream (`/api/events/stream`) **and** the
   `/api`, `/admin`, `/app` paths.
3. The home-NAT connectivity model interaction (clients connect **out**
   to the server for the event stream; the server reaches clients over
   SSH — see `docs/architecture.md`).

## Facts to anchor against (verified in the codebase / docs, 2026-06-20)

- The dashboard listens plain HTTP on `0.0.0.0:8000` (server-deployment
  → First-run setup step 5).
- Surfaces: `/` (landing), `/healthz`, `/api/*`, `/admin`, `/app`
  (`web/app.ts`, `web/frontend.ts`). `/admin` and `/app` are canonical
  slash-free URLs; the trailing-slash form 308-redirects.
- Event stream `/api/events/stream` is a long-lived, **client-initiated
  outbound** WebSocket with bearer-token auth
  (`docs/architecture.md` → Data flow table; taxonomy in the events
  module).
- Telemetry pull + policy push are **server → client over SSH**
  (`docs/architecture.md` → Inbound/Outbound). The reverse proxy fronts
  only the HTTP surface; SSH stays LAN-side and is unaffected.
- Session cookie is signed, `HttpOnly`, `SameSite=Strict`, **not
  `Secure`** (`server-deployment.md` → Authentication; TLS is enforced at
  the proxy). Worth stating that `SameSite=Strict` + cross-site phone
  access still works because the cookie is first-party to the proxied
  origin.
- The per-IP failed-attempt limiter keys on `request.ip`
  (`auth/routes.ts:41`, `api/clients/routes.ts:102`); Fastify is built
  **without `trustProxy`** (`web/app.ts`). So behind a proxy every
  request carries the proxy's IP and the per-IP limiter degrades to a
  single global bucket. Document the consequence and the proxy-side
  mitigation (proxy-level rate limiting), and file a follow-up issue to
  add an opt-in `trustProxy` setting.

## Structure of the doc

1. When you need this (LAN vs. non-LAN; what the proxy does/does not change).
2. What to proxy — the surface map table (`/`, `/healthz`, `/api`,
   `/api/events/stream`, `/admin`, `/app`) + the WebSocket upgrade note.
3. Connectivity model — proxy fronts HTTP only; SSH transport is LAN /
   server→client and untouched.
4. Example configs: Caddy (auto-HTTPS), nginx (with `Upgrade`/`Connection`
   map for the WS), Traefik (compose labels).
5. Application-layer caveats behind a proxy: cookie `Secure`/HTTPS,
   `request.ip` / rate-limiter degradation + `trustProxy` follow-up,
   request body size / timeouts for the long-lived WS.
6. Cross-references.

## Steps

1. Write `docs/reverse-proxy-tls.md`.
2. Add a cross-link in `docs/server-deployment.md` near the existing
   reverse-proxy note.
3. File follow-up issue: opt-in `trustProxy` so the per-IP limiter sees
   real client IPs behind a proxy. Link it from the doc + PR.
4. `prettier --check` is server-scoped and won't touch root docs, but run
   the gate from `server/` anyway to confirm nothing regressed.
5. Commit, push to the session branch, open a draft PR, review, mark ready.

## Deferred (tracked)

- `trustProxy` runtime option → new follow-up issue (code change, its own
  PR).
