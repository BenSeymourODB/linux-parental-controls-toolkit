# Dashboard frontend (`server/frontend/`)

One SvelteKit project (Svelte 5, `@sveltejs/adapter-static`) providing both
dashboard surfaces as **statically prerendered** assets:

- `/admin` — desktop admin experience. Real policy editors, burndown charts,
  and drag-to-reorder UI land in **Phase 2**.
- `/app` — mobile-first PWA surface. Real per-child status and parent
  limit-adjustment screens land in **Phase 9**.

Today this is scaffold only: each route group has a single placeholder page
proving the toolchain. `/` and `/api/*` are **not** owned by this project —
the Fastify backend serves those directly (see `CLAUDE.md` → frontend split).

## Build output

`npm run build` runs `svelte-check` (TypeScript at the Svelte/API boundary)
and then `vite build`, emitting fully prerendered HTML/JS/CSS into:

```
server/frontend/build/
```

`adapter-static` is configured with `strict: true`, so the build fails if any
route is not prerenderable — the runtime image is a plain static file server
for these assets and has **no Node frontend toolchain**. The Docker builder
stage (#6) runs this build and copies the output into the runtime image
(under `/app/frontend`); the Fastify `web` module mounts that directory via
`@fastify/static` and serves it at `/admin` and `/app` (the live static mount
landed in Phase 2, #40 — see `server/src/web/frontend.ts`).

The mount root is `PCT_FRONTEND_ROOT` (default `/app/frontend`), so local dev
can point it at `server/frontend/build`. The surface URLs (`/admin`, `/app`)
serve `admin.html` / `app.html`, and each surface also owns a `…/*` fallback so
a deep client-side route on a hard refresh (e.g. `/admin/settings`) serves the
entry page rather than 404ing — letting the client router take over (#59). That
works because asset references are **root-absolute** (`/_app/…`, via
`kit.paths.relative = false`), so they resolve at any document depth; the
trailing-slash form just falls through the same fallback (no redirect). If the
directory is absent the mount is skipped (the surfaces 404) rather than failing
startup. `/`, `/healthz`, and `/api/*` stay owned by the backend.

`build/` is git-ignored (by both the repo-root `.gitignore` and the local
`server/frontend/.gitignore`) — it is a build artefact, produced at
image-build time, never committed.

## Request logging

This project ships **no SvelteKit server runtime** — `adapter-static`
prerenders everything to static HTML/JS/CSS, so there is nothing to "wire
pino into" on the frontend itself. The only server that ever handles an
`/admin` or `/app` request is Fastify.

The `web` module mounts `build/` via `@fastify/static` (#40), so those
static-asset requests flow through the **same** request logging the backend
already configures (`server/src/web/logger.ts`, #11) — no frontend-specific
logging setup is needed or wanted:

- Each request carries a `reqId` (an inbound `X-Request-Id` header is
  honoured, otherwise a UUID is generated), so a request for an `/admin`
  asset is traceable end to end.
- Any custom plugin or hook added around the static mount must log via
  `request.log` (never `console.*`, which ESLint forbids in `src/`); any
  non-request helper takes a child logger via `componentLogger(app, "...")`.

Browser-side diagnostics (`console` inside a Svelte component) are a separate
concern from server logs; if we ever want them captured server-side, that
belongs behind a `/api` telemetry route, not a second logger.

## Local development

```bash
cd server/frontend
npm ci
npm run dev      # vite dev server with HMR (http://localhost:5173)
npm run build    # svelte-check + vite build → ./build
npm run preview  # serve the built ./build locally
npm run check    # svelte-check only (svelte-kit sync + tsc at the boundary)
npm test         # vitest: api wrappers + component/flow smoke tests
```

## Testing

`npm test` runs Vitest across two projects (`vitest.config.ts`), all against a
**mocked `/api` — never a live backend**:

- **`api`** (`tests/api/**`, `node` environment) — the pure `/api` layer: the
  typed `fetch` client and the per-entity wrappers. Mocks `globalThis.fetch`
  and asserts the right method/URL/body crosses the wire.
- **`components`** (`tests/components/**`, `jsdom` environment) — Svelte
  component / flow smoke tests rendered with
  [`@testing-library/svelte`](https://testing-library.com/docs/svelte-testing-library/intro/).
  The SvelteKit plugin compiles the components and resolves their `$lib` /
  `$app` imports; the relevant `$lib/api/*` wrapper is `vi.mock`ed so the test
  drives real component behaviour over canned responses. Current coverage:
  - `admin-auth-flow.test.ts` — the `/admin` orchestrator
    (`routes/admin/+page.svelte`): the unauthenticated-probe redirect to the
    login form, a successful login swapping to the authenticated shell, a
    failed login surfaced inline, and logout returning to the form.
  - `users-view-crud.test.ts` — `UsersView` end to end (the canonical editor
    pattern the other editors repeat): list → create → inline edit → delete,
    plus the shared inline error surface (`role="alert"`).
  - `clients-view-crud.test.ts` / `activities-view-crud.test.ts` — the two
    editors that are straight repeats of the `UsersView` pattern, confirming it
    generalises (Activities adds the enum `<select>` create flow).

The logic-heavy editors (Budgets, Schedules, Exceptions, Activity Groups,
Client Health, Audit Log, Links) carry real client-side behaviour beyond the
CRUD skeleton — duration/bitmask/`datetime-local` conversions, membership
management, conditional target pickers, pagination — and are covered by their
own follow-up issue rather than this slice.

Deeper in-browser E2E (Playwright) is intentionally **out of scope** — these
headless component tests cover the highest-value flows without a heavyweight
browser harness. CI runs `npm test` in the `SvelteKit build` job alongside
`npm run check` and `npm run build`.

The frontend has its own toolchain and is intentionally **excluded from the
backend's ESLint / Prettier / tsc scope** (see `server/eslint.config.js`,
`server/.prettierignore`, and the repo's pre-commit config). Run the backend
quality gate from `server/` and the frontend checks from `server/frontend/`.
