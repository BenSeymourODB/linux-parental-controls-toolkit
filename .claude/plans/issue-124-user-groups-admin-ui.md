# Plan — User-groups management admin UI (#124 slice)

Roadmap: `docs/roadmap.md` → Phase 2 (policy store, JSON API, admin UI shell).

## Context

Issue #124 ("user groups + group-level schedules with per-user override
precedence") is an umbrella whose foundation has already shipped:

- **#181** — `UserGroup` entity, multi-group membership, and the full
  `/api/user-groups` CRUD + membership API (backend).
- **#182** — group-targeting on `Schedule`/`Exception` + the user-over-group
  resolver (backend).
- **#63** (closed 2026-06-23) — the user drag-to-order schedule editor.

What is still missing for #124 is the **frontend**: there is no
`$lib/api/user-groups` client, no `UserGroupsView`, and no nav entry, so an
admin cannot manage user groups from the dashboard at all even though the API
exists. This slice delivers exactly that surface.

## Scope (this PR)

Mirror the proven `ActivityGroupsView` master-detail pattern (#189), but the
members are `User` rows instead of `Activity` rows.

1. **`server/frontend/src/lib/api/user-groups.ts`** — thin typed wrappers over
   `apiFetch`, types imported from the shared `/api` contract (never
   re-declared):
   - `listUserGroups()` → `GET /api/user-groups`
   - `createUserGroup(input)` → `POST /api/user-groups`
   - `updateUserGroup(id, input)` → `PATCH /api/user-groups/:id`
   - `deleteUserGroup(id)` → `DELETE /api/user-groups/:id`
   - `listGroupMembers(groupId)` → `GET /api/user-groups/:groupId/members`
   - `addUserToGroup(groupId, userId)` → `PUT /api/user-groups/:groupId/members/:userId`
   - `removeUserFromGroup(groupId, userId)` → `DELETE /api/user-groups/:groupId/members/:userId`

2. **`server/frontend/src/lib/api/contract.ts`** — add the type re-exports
   `UserGroupResponse`, `CreateUserGroupRequest`, `UpdateUserGroupRequest`
   from `src/api/policy/dtos.js` (`UserResponse` is already re-exported).

3. **`server/frontend/src/lib/views/UserGroupsView.svelte`** — list groups,
   create / inline-rename / delete, and (lazy, per expanded group) assign /
   remove member users. `User` rows render by `displayName`; the add-member
   dropdown excludes users already in the group.

4. **`server/frontend/src/routes/admin/+page.svelte`** — import the view, add a
   `{ id: "user-groups", label: "User Groups" }` nav item (next to "Users"),
   and the `{:else if activeView === "user-groups"}` branch.

5. **Tests** following the established pattern:
   - `server/frontend/tests/api/user-groups.test.ts` — URL/method/body per call.
   - `server/frontend/tests/components/user-groups-view.test.ts` — lazy member
     load, candidate exclusion, add/remove mutates the list, collapse, and
     inline error surfacing.

## Out of scope (deferred, tracked)

- **Group-schedule drag-to-order editor** — already filed as **#270**.
- **Inherited-vs-local indicator on the per-user schedule editor** — the last
  #124-specific piece; a focused follow-up issue will be filed and referenced
  from the PR. #124 stays open until it lands (this PR is *Part of* #124).

## License boundary

None. Frontend, JSON-API-only; type-only imports from the shared contract
(erased at build). No GPL surface, no transport/packaging change.

## Validation

`cd server/frontend && npm ci && npm run build` (CI parity) plus the frontend
component/API vitest suites, and the server quality gate
(`format`/`lint`/`typecheck`/`test`) from `server/`.
