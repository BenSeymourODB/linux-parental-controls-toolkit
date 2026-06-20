# Plan — #189 Admin UI: remaining policy editors (slice: Clients + Activities)

Follow-up to the #53 foundation slice (typed `/api` client + login/session +
app shell + the **Users** CRUD editor). #189 covers all remaining `/admin`
editors; this session lands a focused, shippable slice and leaves #189 open to
track the rest.

## Scope of this PR

Two full CRUD editors, each repeating the exact pattern the Users editor
established (typed `apiFetch` wrappers over the shared inferred DTOs, an
in-page `*View.svelte` with list/create/inline-edit/delete, wired into the
`/admin` shell nav):

1. **Clients** — `/api/clients` (`hostname`, `sshUser`); surface read-only
   `enrolledAt` + `lastSeen`. The richer health/status view is Phase 3 / #81,
   not here.
2. **Activities** — `/api/activities` (`kind` ∈ {app, app_group, domain,
   domain_group}, `matcher`).

### Deferred — stays tracked on #189 (PR is "Part of #189", not "Closes")

- Activity Groups (+ membership) editor — `/api/activity-groups`.
- Budgets editor — `/api/budgets`.
- Schedules / Exceptions editors — `/api/schedules`, `/api/exceptions`
  (drag-to-order + first-match-wins stays #63; recurring-window authoring #140).
- User ↔ Client links editor — `/api/users/:userId/clients`.
- Deep `/admin/*` URL routes + SPA fallback — #59.

## Files

- `server/frontend/src/lib/api/contract.ts` — add type-only re-exports for the
  client + activity DTOs (`ClientResponse`, `Create/UpdateClientRequest`,
  `ActivityResponse`, `Create/UpdateActivityRequest`). **Never** hand-write a DTO.
- `server/frontend/src/lib/api/clients.ts` — `listClients/createClient/
  updateClient/deleteClient` over `apiFetch`.
- `server/frontend/src/lib/api/activities.ts` — `listActivities/createActivity/
  updateActivity/deleteActivity`.
- `server/frontend/src/lib/views/ClientsView.svelte` — list/create/edit/delete.
- `server/frontend/src/lib/views/ActivitiesView.svelte` — list/create/edit/delete
  with a `kind` `<select>` over the four activity kinds.
- `server/frontend/src/routes/admin/+page.svelte` — add `clients` + `activities`
  nav items and render the new views in the in-page switcher.
- `server/frontend/tests/api/clients.test.ts`,
  `server/frontend/tests/api/activities.test.ts` — vitest unit tests mirroring
  `tests/api/users.test.ts` (URL/method/body assertions, 204 on delete).

## Constraints honoured

- Frontend talks **only** to `/api/*`; no privileged in-process shortcuts.
- All `/api` calls are browser-guarded (page is prerendered to a static shell
  under `adapter-static`).
- License boundary: type-only DTO imports, plain browser `fetch`. No GPL
  surface, no transport/packaging change.

## Validation

- `server/frontend`: `npm run check` (svelte-check) + `npm run test` (vitest)
  + `npm run build` (svelte-kit sync && vite build) all green.
- The server quality gate is unaffected (no `server/src` change) but re-run
  `format:check`/`lint`/`typecheck`/`test` from `server/` to be safe.
