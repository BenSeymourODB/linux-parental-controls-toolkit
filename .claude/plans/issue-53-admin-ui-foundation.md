# Issue #53 — SvelteKit admin UI (`/admin/*`): policy editors — **foundation slice**

Roadmap: `docs/roadmap.md` → Phase 2 (the Phase-2 capstone). This plan covers a
clean, shippable **foundation slice**; the remaining editors are split to a
tracked follow-up.

## Why a slice

#53 is the whole authenticated admin experience (login + CRUD for users,
clients, activities/groups, budgets, schedules). That is far more than one
session should land as a single reviewable PR. This slice establishes the
**pattern end-to-end** — the typed `/api` client, auth/login + session guard,
the app shell, and one real CRUD editor (Users) — so the deferred editors are
mechanical repetition of a proven shape.

## Hard constraints discovered

1. **Static-only frontend.** `adapter-static` + `prerender = true` +
   `strict: true`. Every route is prerendered to HTML; data loads
   **client-side** in the browser (`onMount`, guarded by `$app/environment`'s
   `browser`). No SvelteKit server `load`/SSR.
2. **The static mount (#40) serves only `/admin`→`admin.html` and
   `/app`→`app.html`.** Deep prerendered routes (`/admin/users`) are *not*
   served (no `.html` suffixing) and their **relative** asset paths
   (`./_app/…`) would resolve against the wrong base. Serving deep routes /
   SPA fallback + asset base is **#59's** job (deferred, "blocked by #53").
   → This slice therefore lives entirely under the single `/admin` page and
   switches views with **client-side state**, not URL routes. Hard refresh
   always lands on `/admin`, which re-derives auth state client-side. No #59
   dependency, no mount change.
3. **Shared types, no duplicated DTOs** (`CLAUDE.md`, #53). The frontend
   imports the **inferred zod DTO types** (type-only) from the server `/api`
   source. svelte-check resolves the server graph's bare imports (`zod`,
   `drizzle-orm`) from `server/node_modules`, so the CI `frontend-build` job
   must `npm ci` the server first. `import type` is erased by the Svelte/TS
   transform, so `vite build` never bundles server code (no runtime coupling,
   no GPL/license concern — zod is MIT, drizzle Apache-2.0).

## API surface consumed (already shipped, #50/#51/#52)

- `POST /api/auth/login` `{username,password}` → `SessionResponse`
- `POST /api/auth/logout` → `SessionResponse`
- `GET  /api/auth/session` → `SessionResponse` (`{authenticated, username?}`)
- `GET /api/users`, `POST /api/users`, `GET/PATCH/DELETE /api/users/:id`
- Error envelope: `{ error: { code, message, details? } }`

## Files (under `server/frontend/`)

- `src/lib/api/contract.ts` — type-only re-exports from server DTOs (the single
  frontend import surface): `SessionResponse`, `LoginRequest`, `UserResponse`,
  `CreateUserRequest`, `UpdateUserRequest`, `ErrorEnvelope`, `ErrorDetail`.
- `src/lib/api/client.ts` — `ApiError` (client-side) + `apiFetch<T>()`:
  `credentials:"same-origin"`, JSON, parses the error envelope, throws a typed
  error; surfaces `401` distinctly so the shell can show the login view.
- `src/lib/api/auth.ts` — `login`, `logout`, `fetchSession`.
- `src/lib/api/users.ts` — `listUsers`, `createUser`, `updateUser`, `deleteUser`.
- `src/lib/components/LoginForm.svelte` — username/password, error display.
- `src/lib/components/AppShell.svelte` — sidebar nav + main slot + logout.
- `src/lib/views/UsersView.svelte` — list + create + inline edit + delete.
- `src/routes/admin/+page.svelte` — orchestrator: `$state` session; renders
  `LoginForm` when unauthenticated, else `AppShell` with the active view.

## Tests (vitest — lightweight, repo's existing runner; **not** Playwright)

- `tests/api/client.test.ts`, `auth.test.ts`, `users.test.ts` — mock global
  `fetch`: happy paths, error-envelope parsing, 401 handling, body/method/URL.
- Add `vitest` devDep + `vitest.config.ts` + `test`/`test:run` scripts.
- Components covered by `svelte-check` + a green `vite build` (no E2E harness
  stood up — that is its own roadmap item, per the implement-issue guide).

## CI

- `frontend-build` job: `(cd server && npm ci)` before the frontend build so
  the shared `/api` types resolve; add `npm test` for the new unit tests.

## Deferred (new follow-up issue, linked from PR)

- Remaining editors: Clients, Activities/Groups, Budgets, Schedules.
- URL-addressable deep `/admin/*` routes + SPA fallback + asset base → **#59**.
- Drag-to-order schedule editor + first-match-wins → **#63**.
- Burndown charts + live updates → Phase 5 / 8b.

## Validation gate

`cd server && npm run format:check && npm run lint && npm run typecheck && npm test`
(server unaffected) and
`cd server/frontend && npm run check && npm test && npm run build`.
