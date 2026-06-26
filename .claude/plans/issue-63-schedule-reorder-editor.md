# Issue #63 — Schedule drag-to-order editor (deferred UI half)

Roadmap: Phase 2 (policy model + admin UI). Companion to
`issue-63-schedule-precedence.md`, which delivered the **surface-agnostic
precedence foundation** (ADR 0004, `schedules.ordinal`,
`policy/schedule-precedence.ts`). That plan explicitly deferred the editor UI
until the admin shell existed:

> Drag/keyboard reorder UI, live "in effect now" + conflict surfacing → #53.

The admin shell now exists (`SchedulesView.svelte` and siblings under
`server/frontend/src/lib/views/`). This plan delivers the deferred work.

## What already exists (do not re-build)

- `policy/schedule-precedence.ts`: `byOrdinal`, `resolveEffectiveRule`,
  `reorder(rules, orderedIds)` (permutation-validated, dense `0..n-1`,
  throws `ReorderMismatchError`), `findShadowedRules` (conservative shadow
  detector returning `{ shadowedId, shadowedById }`).
- `policy/resolve.ts`: `ruleActiveAt(at, tz)` → a `RuleActivePredicate`,
  `isRuleActiveAt`. The "is this rule's window active at instant X" decision.
- `schedules.ordinal` column + `schedules_user_ordinal_idx`; per-rule
  `ordinal` is already settable via POST/PATCH; `repo.listUserSchedules`
  returns a user's rows in evaluation order (ascending `ordinal`, then `id`).
- `ScheduleResponse` already carries `ordinal`.
- Frontend `/api` boundary is **type-only** (`contract.ts`: "vite build
  never bundles server code"). → precedence logic stays server-side and is
  surfaced over the API; the editor never re-implements the math.

## Architecture decision

Keep **all** precedence computation on the server (the single source of
truth the foundation established) and add a per-user *order view* endpoint
that returns the ordered rules plus the two derived facts the editor needs
(which rules are shadowed, which rule is in effect right now per target).
The atomic reorder is a dedicated endpoint, not N PATCHes, so a drag-save
can never leave duplicate/holey ordinals or partially apply.

## Scope boundaries

- **In:** user-owned `schedules` reorder + the editor for them.
- **Out (deferred, noted in PR / tracked by issues):**
  - reorder of inherited **group** schedules (no group-schedule editor view
    exists yet) — file/track a follow-up.
  - windowed-rule authoring (#140) — editor still only creates always-on
    rules; the order view honours whatever windows exist.
  - shadow analysis spanning group inheritance — kept conservative, matching
    `findShadowedRules`' own documented limits.
  - Exceptions order by `expiresAt`, not `ordinal`, so they are unaffected
    by this issue (despite the title saying "schedule/exception").

## Phase 1 — Backend: atomic reorder + order-view read

### Repository (`policy/repository.ts`)
- `reorderUserSchedules(db, userId, orderedIds): ScheduleRow[]`
  - read the user's rows (`listUserSchedules`), call `reorder()` to validate
    the permutation and compute dense ordinals, then persist inside a single
    `db.transaction(...)` (better-sqlite3 synchronous tx), returning the rows
    in the new order. `reorder`'s `ReorderMismatchError` propagates.

### DTOs (`api/policy/dtos.ts`)
- `reorderSchedulesSchema` = `{ orderedIds: z.array(z.number().int()).min(1) }`
  (uniqueness + completeness are validated against the actual row set in the
  route/`reorder`, which gives a precise error).
- `shadowFindingSchema` → `{ shadowedId, shadowedById }`.
- `scheduleOrderViewSchema` →
  `{ schedules: ScheduleResponse[], shadows: ShadowFinding[], effectiveIds: number[] }`
  + `toScheduleOrderView(rows, shadows, effectiveIds)`.
- Export new schemas/types from `api/policy/index.ts` and re-export the types
  from the frontend `contract.ts`.

### Route (`api/policy/routes.ts` — needs `settings` for default tz)
`registerPolicyRoutes` does not currently take `settings`; the order view
needs the server-default tz for `ruleActiveAt`. Thread `settings` in (mirror
`registerEffectiveRoutes(scope, settings)`); update the caller in
`api/index.ts`/wherever `registerPolicyRoutes` is invoked.
- `GET /users/:userId/schedules/order` → `ScheduleOrderView`
  - 404 if user missing.
  - rows = `repo.listUserSchedules`; map to `ScheduleRule`; compute
    `shadows = findShadowedRules(rules)`; `effectiveIds` = for each distinct
    `(targetKind,targetId)`, `resolveEffectiveRule(group, ruleActiveAt(now, tz))?.id`
    where `tz = resolveEffectiveTz(user.tz, settings.defaultTz)`.
- `PUT /users/:userId/schedules/order` body `reorderSchedulesSchema`
  → `ScheduleOrderView` (same shape, recomputed after the reorder).
  - 404 if user missing; `ReorderMismatchError` → `ApiError(409, "conflict", …)`
    so a stale/garbled order is rejected, not silently dropped.

### Tests
- `tests/policy/repository.test.ts` (or a focused file): reorder densifies,
  preserves rows, is atomic, and surfaces `ReorderMismatchError` on a
  non-permutation.
- `tests/api/policy/*.test.ts`: GET order view (shadow + effective ids),
  PUT reorder happy path, 404 user, 409 bad permutation.

## Phase 2 — Frontend: drag + keyboard reorder editor

### `lib/api/schedules.ts`
- `getScheduleOrder(userId): Promise<ScheduleOrderView>` → GET.
- `reorderSchedules(userId, orderedIds): Promise<ScheduleOrderView>` → PUT.

### `lib/views/SchedulesView.svelte`
- Add a **user selector**; on select, load that user's order view. (Reorder
  is per-user; a flat all-users table can't express it.) Keep create / edit
  action / delete, scoped to the selected user; create appends and reloads
  the order view.
- Render rows in `ordinal` order with, per row:
  - a **drag handle** (`draggable`, native HTML5 DnD — no new dependency) to
    reorder by mouse;
  - **keyboard-accessible** "Move up"/"Move down" buttons (focusable,
    `aria-label`), so reordering works without a pointer;
  - an **"In effect now"** badge when the row id ∈ `effectiveIds`;
  - a **"Never applies — shadowed by the rule above"** warning when the row
    id is a `shadows[].shadowedId` (name/point at `shadowedById`).
- On drop / move, optimistically reorder locally, call `reorderSchedules`,
  and replace state from the returned view (authoritative shadow/effective).
  On error, reload + surface the inline `role="alert"` message.

### Tests (`tests/components/schedules-view-reorder.test.ts`)
Headless harness pattern (`@testing-library/svelte`, `vi.mock` the api
wrappers, no live backend): select a user → renders ordered rows; "Move
down" calls `reorderSchedules` with the swapped id order and re-renders from
the response; shadowed row shows the warning; effective row shows the badge.

## Validation (each phase, from `server/`)
`npm run format && npm run lint:fix && npm run typecheck && npm test`
(coverage gate 80%), plus `cd server/frontend && npm run build` for the UI
phase.

## License-boundary note
N/A — pure TS policy logic + JSON API + Svelte UI. No GPL linkage, no
transport/packaging/Docker change. The frontend stays type-only across the
`/api` boundary (no server runtime bundled).
