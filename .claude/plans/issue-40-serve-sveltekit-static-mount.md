# Issue #40 — Serve the SvelteKit build via `@fastify/static` at `/admin` and `/app`

Roadmap: `docs/roadmap.md` → Phase 2.

## Goal

Wire the Fastify `web` module to serve the prerendered SvelteKit build
(`adapter-static` output) at the `/admin` and `/app` surfaces, plus its
shared `_app/…` assets, without shadowing the existing `GET /`
("hello, no policy yet") or `/healthz` routes.

## Constraints from the issue + repo conventions

- `@fastify/static` is already a dependency — no new dep.
- Asset root must be **configurable** (default the in-image `/app/frontend`
  path the Dockerfile copies the build into) so unit tests can point the
  mount at a fixture directory.
- Static-asset requests flow through the existing pino request logging
  (`web/logger.ts`, #11). Any helper logs via the component child logger,
  never `console.*`.
- `GET /` and unknown routes behave as today.
- `adapter-static` (prerender entries `/admin`, `/app`) emits
  `build/admin.html`, `build/app.html`, shared `build/_app/…`, and static
  files (e.g. `favicon.png`).
- License boundary: N/A — pure Node/Fastify static serving, no GPL touch.

## Design

### 1. Config (`src/config.ts`)
Add `frontendRoot: z.string().min(1).default("/app/frontend")`, sourced from
`PCT_FRONTEND_ROOT`. Default matches the Dockerfile copy target
(`COPY --from=frontend-builder /app/frontend/build ./frontend`, WORKDIR
`/app`).

### 2. Frontend plugin (`src/web/frontend.ts`)
A small Fastify plugin `registerFrontend(app, settings)`:
- If `settings.frontendRoot` does not exist on disk, log a warning via
  `componentLogger(app, "web/frontend")` and **skip** the mount. This keeps
  `buildApp()` usable in dev/CI where no build is present (the existing tests
  call `buildApp()` with the default `/app/frontend`, which won't exist), and
  matches reality: the runtime image always has the build.
- Otherwise register an encapsulated plugin that:
  - `register(fastifyStatic, { root, prefix: "/", index: false })` so shared
    assets (`/_app/*`, `/favicon.png`, …) are served at the root, and
    `reply.sendFile` is decorated in that scope.
  - adds `GET /admin` (+ `/admin/`) → `reply.sendFile("admin.html")` and
    `GET /app` (+ `/app/`) → `reply.sendFile("app.html")`.

Route precedence: the static plugin registers the wildcard `GET /*`; the
exact `GET /` and `GET /healthz` on the parent app win over it, so the landing
page and probe are unaffected. The explicit `/admin` / `/app` routes win over
the wildcard too. `index: false` stops `@fastify/static` from registering its
own `GET /` (which would collide).

### 3. Wire into `buildApp()`
Call `registerFrontend(app, settings)` after the `/` and `/healthz` routes.
`app.register(...)` is queued and resolved at `ready()`/`inject()` time, so
`buildApp()` stays synchronous.

## Tests (`tests/web/frontend.test.ts`)
Build a temp fixture dir (`admin.html`, `app.html`, `_app/immutable/x.js`,
`favicon.png`), point `PCT_FRONTEND_ROOT` at it, and assert via `app.inject()`:
- `GET /admin` → 200, `text/html`, admin marker in body.
- `GET /app` → 200, `text/html`, app marker.
- `GET /_app/immutable/x.js` → 200, asset content.
- `GET /favicon.png` → 200.
- `GET /` → still `hello, no policy yet` (not shadowed).
- `GET /healthz` → ok.
- `GET /nope` → 404.
- Missing-root case: `PCT_FRONTEND_ROOT` at a nonexistent path → `buildApp()`
  works, `GET /admin` → 404, `GET /` still works, and a `web/frontend` warning
  is emitted (capture via `loggerStream`).

## Docs
- `.env.example`: document `PCT_FRONTEND_ROOT`.
- `server/frontend/README.md`: mark the static mount as landed.
- `docs/server-deployment.md`: note the mount if env vars are listed there.

## Out of scope (deferred)
- Real `/admin` editors and `/app` PWA screens (#53 / Phase 9).
- E2E/Playwright harness (own roadmap item).
