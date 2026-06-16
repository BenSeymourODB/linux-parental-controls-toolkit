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
(under `/app/frontend`); the Fastify `web` module will mount `build/` and
serve it at `/admin` and `/app` (the live static mount lands in Phase 2 with
the real UI).

`build/` is git-ignored (by both the repo-root `.gitignore` and the local
`server/frontend/.gitignore`) — it is a build artefact, produced at
image-build time, never committed.

## Request logging

This project ships **no SvelteKit server runtime** — `adapter-static`
prerenders everything to static HTML/JS/CSS, so there is nothing to "wire
pino into" on the frontend itself. The only server that ever handles an
`/admin` or `/app` request is Fastify.

When the `web` module mounts `build/` via `@fastify/static` (Phase 2),
those static-asset requests flow through the **same** request logging the
backend already configures (`server/src/web/logger.ts`, #11) — no
frontend-specific logging setup is needed or wanted:

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
```

The frontend has its own toolchain and is intentionally **excluded from the
backend's ESLint / Prettier / tsc scope** (see `server/eslint.config.js`,
`server/.prettierignore`, and the repo's pre-commit config). Run the backend
quality gate from `server/` and the frontend checks from `server/frontend/`.
