# Issue #270 — Admin: drag-to-order editor for group-targeted schedules

Roadmap: Phase 2 (policy store, JSON API, admin UI shell). Follow-up to #63
(user-schedule reorder editor) and #182 (group-targeted schedules/exceptions).

## Goal

Group-targeted schedules (#182) carry a per-group `ordinal` and the same
first-match-wins precedence within a group as user schedules, but there is **no
editor** for their order. Mirror the user path (#63) for groups: an atomic
reorder endpoint + an order-view read, and a drag-to-order admin surface.

## Product decision — "in effect now" for the group view

A user has a single effective timezone, so the user order view (#63) can resolve
which rule is **in effect right now** for a `RuleActivePredicate` built from the
user's tz. A **group has no single timezone** — its members may sit in different
zones, and a group rule's live effect is only meaningful once resolved per member
(which `GET /users/:userId/effective` already does in the member's tz).

**Decision: omit the "in effect now" badge from the group view.** The group
order view returns the rules in evaluation order plus the `shadows` finding —
which is purely *structural* (identical recurrence window + target superset, no
tz, ADR 0004 / #63) and so stays fully meaningful and valuable for the group
editor. We do **not** invent a tz-less notion of "active now". This matches the
issue's second suggested option and keeps the precedence math in exactly one
place (`policy/schedule-precedence.ts`).

Consequence: a distinct `GroupScheduleOrderView` DTO ( `{ schedules, shadows }`,
no `effectiveIds`) rather than reusing `ScheduleOrderView`.

## Phases

### Phase 1 — Backend: repo reorder + DTO + routes + tests

- `policy/repository.ts`: `reorderGroupSchedules(db, groupId, orderedIds)`
  mirroring `reorderUserSchedules` — validate the permutation with the shared
  `reorder()` (throws `ReorderMismatchError`), write dense `0..n-1` ordinals in
  one transaction, re-read in the new order.
- `api/policy/dtos.ts`: `groupScheduleOrderViewSchema` /
  `GroupScheduleOrderView` (`schedules: groupScheduleResponseSchema[]`,
  `shadows: shadowFindingSchema[]`) + `toGroupScheduleOrderView(rows, shadows)`.
- `api/policy/schedule-order.ts`: extend `registerScheduleOrderRoutes` with
  `GET`/`PUT /api/user-groups/:groupId/schedules/order`. 404 on unknown group
  (`repo.getUserGroup`), 409 on `ReorderMismatchError`, 400 on empty list
  (reuse `reorderSchedulesSchema`). `shadows` from `findShadowedRules` on the
  group rows; **no** `effectiveIds` / no tz / no resolver call.
- Tests: `tests/api/group-schedule-order.test.ts` mirroring
  `schedule-order.test.ts` (401, 404 GET+PUT, order view + shadows, atomic
  reorder flips shadow, 409 non-permutation, 400 empty). Assert the view has
  **no** `effectiveIds` key.

No push fan-out on reorder — matches the user path (#63), where reorder is in
the same separate module and does not push. Noted in the PR.

### Phase 2 — Frontend: API client + view + nav + tests

- `frontend/src/lib/api/contract.ts`: re-export `UserGroupResponse`,
  `GroupScheduleResponse`, and the new `GroupScheduleOrderView`.
- `frontend/src/lib/api/user-groups.ts`: minimal `listUserGroups()` (the group
  picker needs it; the full user-groups admin UI is #124/PR #294 — only the
  read used here is added).
- `frontend/src/lib/api/schedules.ts`: `getGroupScheduleOrder(groupId)` +
  `reorderGroupSchedules(groupId, orderedIds)`.
- `frontend/src/lib/views/GroupSchedulesView.svelte`: mirror `SchedulesView`,
  picking a **group** instead of a user; drag handle + Move up/down; shadow
  warning; **no** "in effect now" badge. Read-only recurrence summary as in
  `SchedulesView`. No create/edit/delete of group rules here (that is the
  group-schedules CRUD, separate) — scope is the **reorder editor** per the
  issue title; mirror just the ordering surface to keep the slice tight.
- Wire a "Group Schedules" nav item into `routes/admin/+page.svelte`.
- Tests: `frontend/tests/components/group-schedules-view-reorder.test.ts`
  (mirror the user reorder smoke test: load ordered rules + shadow warning,
  Move down persists, drag-drop persists, reorder-failure resync) and
  `frontend/tests/api/group-schedules.test.ts` for the two new wrappers.

## License boundary

None touched — plain TypeScript + zod + Drizzle + SvelteKit. No GPL surface, no
transport/packaging change.

## Deferred / out of scope

- Group-schedule **CRUD** authoring in the dashboard UI (create/edit/delete of
  group rules) — the backend CRUD exists (#182); a full group-schedule editor
  surface is its own slice. This issue is the *reorder* editor.
- Per-member "in effect now" preview in the group view — intentionally omitted
  (see decision above); the per-user effective endpoint already covers it.
