# Issue #59 — SPA fallback for deep `/admin/*` and `/app/*` routes on hard refresh

Roadmap: `docs/roadmap.md` → Phase 2 (admin UI / static mount follow-up to #40).

## Problem

The `@fastify/static` mount (`server/src/web/frontend.ts`, #40) serves the two
prerendered surface entry pages (`admin.html`, `app.html`) at the slash-free
surface URLs and the shared `/_app/…` assets. A **deep** client-side route on a
hard refresh — e.g. `GET /admin/settings`, a path that exists only inside the
hydrated SvelteKit app, not as a prerendered file — currently returns `404`
instead of falling back to the surface entry page so the client router can take
over.

The current design avoids serving the entry page at a deep URL because the
prerendered pages reference assets **relatively** (`./_app/…`), which only
resolve to `/_app/…` when the document is served at the canonical slash-free
URL. That is why `/admin/` 308-redirects to `/admin` today.

## Decision

Two coordinated changes (the issue lists both as candidate directions; this is
the one that fits the current two-surface, prerendered architecture):

1. **Root-absolute asset paths** — set `kit.paths.relative = false` in
   `server/frontend/svelte.config.js`. The prerendered pages then reference
   `/_app/…` absolutely, so the entry HTML loads its assets regardless of the
   document URL depth. This removes the *reason* the trailing-slash redirect
   existed.

2. **Per-surface SPA fallback in Fastify** — in `registerFrontend`, serve the
   surface entry page for any unmatched deep path under that surface:
   `GET /admin` **and** `GET /admin/*` → `admin.html`; `GET /app` **and**
   `GET /app/*` → `app.html`. `/`, `/healthz`, `/api/*`, the `/_app/…` assets,
   and root-level static files (`favicon.png`, `/service-worker.js`,
   `/app.webmanifest`, `/app-icons/…`) stay exactly as they are — none of them
   live under the `/admin/` or `/app/` path prefixes, so the wildcard never
   shadows them, and more-specific static routes win over `@fastify/static`'s
   `GET /*` wildcard (already relied on for the surface routes).

   The trailing-slash 308 redirect routes are removed: `/admin/` and `/app/`
   are now covered by the `…/*` fallback (which serves the page), and with
   absolute assets there is no asset-resolution reason to canonicalise.

Per-surface fallback (not `adapter-static`'s single SPA `fallback` page) is
required because we have two distinct surfaces that must fall back to *their
own* entry page.

## Scope / non-scope

- In scope: server-side fallback + absolute asset base so a deep-link hard
  refresh returns the entry page (HTTP 200) and its assets load. This is the
  enabling infrastructure.
- Not in scope: introducing actual URL-addressable deep routes inside the
  editors (the `/admin` surface is still a single prerendered page with an
  in-page view switcher). Adopting deep routes is the #189 follow-up; drag-to-
  order schedule authoring stays #63. The fallback is harmless until then —
  an unknown deep path hydrates the shell and the client router decides.

## Files

- `server/frontend/svelte.config.js` — add `paths: { relative: false }`.
- `server/src/web/frontend.ts` — replace the two trailing-slash redirect
  routes with the `…/*` fallback; rewrite the module doc comment (absolute
  assets + SPA fallback, no more relative-asset/redirect rationale).
- `server/frontend/README.md` — update the trailing-slash paragraph.
- `server/tests/web/frontend.test.ts` — replace the two 308 redirect tests
  with fallback assertions; add deep-route fallback tests for both surfaces;
  keep the assertions that `/`, `/healthz`, `/_app/…`, root static files, and a
  bogus root path are unaffected.

## License boundary

None touched — plain Fastify static file serving + a SvelteKit build-config
flag. No GPL linkage, no subprocess/REST boundary, no Docker-image change.

## Test plan

- `GET /admin/settings` and `GET /app/anything/deep` → 200, HTML, surface marker.
- `GET /admin/` and `GET /app/` → 200 surface page (no longer 308).
- `GET /admin`, `GET /app` → 200 surface page (unchanged).
- `GET /_app/immutable/chunk.js` → 200 JS (unaffected).
- `GET /favicon.png` → 200 (unaffected).
- `GET /`, `/healthz` → backend routes (unaffected).
- `GET /nope` (root, no surface prefix) → 404 (unaffected).
- HEAD on a surface URL → 200; non-GET on a surface URL → 404.
- Build-absent path still warns + 404s (unchanged).
- `cd server/frontend && npm ci && npm run build` succeeds with absolute paths.
