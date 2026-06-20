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

---

# Slice 2 — Activity Groups (+ membership), Budgets, User ↔ Client links

The Clients + Activities slice above has landed on `main`. This slice picks up
the next three editors, repeating the same proven pattern. Schedules /
Exceptions are intentionally **still deferred** to avoid colliding with the
in-flight schedule/exception work (#182 group-targeting, #140 recurring
windows) and the #63 drag-to-order editor; they remain tracked on #189.

## Scope of this PR

1. **Activity Groups** — `/api/activity-groups` CRUD plus **membership**:
   `GET /activity-groups/:groupId/activities`, `PUT|DELETE
   /activity-groups/:groupId/activities/:activityId`. The view is master-detail:
   a groups list (create/edit/delete name) with an expandable member panel that
   adds activities from a dropdown and removes them.
2. **Budgets** — `/api/budgets` CRUD. Create needs `userId`, `scope`
   (overall/activity/group), `targetId` (null for overall, an `activity.id` for
   `activity`, an `activity_group.id` for `group`), `window`
   (daily/weekly/monthly), `secondsAllowed`. The view loads users + activities +
   activity-groups for the target pickers and to render target names.
3. **User ↔ Client links** — `/api/users/:userId/clients` (list per user),
   `PUT|DELETE /users/:userId/clients/:clientId` (upsert/remove with
   `linuxUsername` + `linuxUid`). The view loads users + clients for the
   pickers and is scoped to the selected user.

## Files

- `server/frontend/src/lib/api/contract.ts` — add type-only re-exports:
  `ActivityGroupResponse`, `Create/UpdateActivityGroupRequest`,
  `BudgetResponse`, `Create/UpdateBudgetRequest`, `LinkResponse`,
  `UpsertLinkRequest`, plus the `Scope` / `BudgetWindow` enums.
- `server/frontend/src/lib/api/activity-groups.ts` — group CRUD +
  `listGroupActivities` / `addActivityToGroup` / `removeActivityFromGroup`.
- `server/frontend/src/lib/api/budgets.ts` — `listBudgets(userId?)` +
  create/update/delete.
- `server/frontend/src/lib/api/links.ts` — `listUserLinks` / `upsertLink` /
  `deleteLink`.
- `server/frontend/src/lib/views/ActivityGroupsView.svelte`,
  `BudgetsView.svelte`, `LinksView.svelte`.
- `server/frontend/src/routes/admin/+page.svelte` — add the three nav items +
  render the views.
- `server/frontend/tests/api/{activity-groups,budgets,links}.test.ts` — vitest
  unit tests mirroring `tests/api/activities.test.ts`.

## Still deferred — stays tracked on #189

- Schedules / Exceptions editors (`/api/schedules`, `/api/exceptions`).
- Deep `/admin/*` URL routes + SPA fallback — #59.

Same constraints honoured as Slice 1 (only `/api/*`, browser-guarded calls,
type-only DTO imports, no GPL surface).
