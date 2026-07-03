# Plan — #363: group-budget & group-exception editors + inherited-vs-local budget display

Roadmap: `docs/roadmap.md` → Phase 2 (policy model / group layer). Completes the
UI half of the group-targeted rule work whose backend landed under #134
(group budgets) and #182 (group exceptions). Precedent: `GroupSchedulesView`
(#270) is the closest existing group-scoped editor.

## Acceptance criteria (from the issue)

1. A group budget and a group exception can be created, edited, and deleted
   entirely from `/admin`.
2. The per-user Budgets view marks each slot as local vs inherited-from-group
   (with the group name).
3. Quality gate green.

## Backend state (verified)

The group CRUD endpoints already exist in `server/src/api/policy/routes.ts`:

| Method | Path | body schema | returns |
|---|---|---|---|
| GET | `/user-groups/:groupId/budgets` | — | `GroupBudgetResponse[]` |
| POST | `/user-groups/:groupId/budgets` | `createGroupBudgetSchema` | 201 `GroupBudgetResponse` |
| PATCH | `/group-budgets/:id` | `updateBudgetSchema` (reused) | `GroupBudgetResponse` |
| DELETE | `/group-budgets/:id` | — | 204 |
| GET | `/user-groups/:groupId/exceptions` | — | `GroupExceptionResponse[]` |
| POST | `/user-groups/:groupId/exceptions` | `createGroupExceptionSchema` | 201 `GroupExceptionResponse` |
| PATCH | `/group-exceptions/:id` | `updateExceptionSchema` (reused) | `GroupExceptionResponse` |
| DELETE | `/group-exceptions/:id` | — | 204 |

Note the asymmetry to mirror: **create is nested** under the group; **update /
delete are flat by id**.

### Gap for AC-2 — inherited-vs-local data source

`gatherUserBudgets` (`server/src/policy/group-resolution.ts`) already tags each
resolved budget with a `RuleSource` (`{kind:"user"}` | `{kind:"group",groupId}`),
but `GET /users/:userId/effective` **collapses budgets** into
`overallSeconds` + `perActivitySeconds` and throws the provenance away — no
endpoint currently exposes it.

**Decision:** add a small, read-only endpoint that surfaces `gatherUserBudgets`
verbatim, keeping resolution server-side (the issue's explicit constraint —
"Display only — resolution stays server-side"). This is *not* an enforcement or
resolution-logic change (no overlap with #362 / PR #365, which only changes
where `gatherUser*` is *consumed* for enforcement/push, not its read shape).

- `GET /api/users/:userId/budgets/resolved` → `ResolvedBudgetResponse[]`
  where each row = `{scope, targetId, window, secondsAllowed, source}` and
  `source = {kind:"user"} | {kind:"group", groupId}`.
- Registered alongside the effective route in `effective.ts` (reuses
  `effectiveParamsSchema`, `repo.getUser` 404 guard, `gatherUserBudgets`).
- The frontend maps `groupId → group name` via the existing `listUserGroups()`.

## Phases

### Phase 1 — API contract + clients + resolved endpoint

- `server/src/api/policy/effective.ts`: add `resolvedBudgetResponseSchema` +
  `ResolvedBudgetResponse`, `toResolvedBudgetResponse`, and the
  `GET /users/:userId/budgets/resolved` route.
- `server/frontend/src/lib/api/contract.ts`: re-export `GroupBudgetResponse`,
  `CreateGroupBudgetRequest`, `GroupExceptionResponse`,
  `CreateGroupExceptionRequest`, `ResolvedBudgetResponse`.
- New `server/frontend/src/lib/api/group-budgets.ts`
  (list/create/update/delete) and `group-exceptions.ts` (same). PATCH reuses
  `UpdateBudgetRequest` / `UpdateExceptionRequest`.
- `server/frontend/src/lib/api/budgets.ts`: add `listResolvedBudgets(userId)`.
- Tests: `server/tests/api/policy/effective-resolved-budgets.test.ts` (backend),
  `server/frontend/tests/api/group-budgets.test.ts`,
  `group-exceptions.test.ts`, and resolved-budgets client coverage.

### Phase 2 — group editors + nav

- `GroupBudgetsView.svelte` — mirror `BudgetsView` but the owner select is a
  group picker (per `GroupSchedulesView`); rows show scope/target/window/
  allowance; inline edit of window + allowance; delete.
- `GroupExceptionsView.svelte` — mirror `ExceptionsView` with a group picker;
  action/target/reason/effectiveFrom/expiresAt; inline edit; delete.
- Wire into `server/frontend/src/routes/admin/+page.svelte`: two nav entries
  (`group-budgets`, `group-exceptions`) + switch branches, placed next to
  "Group Schedules" (#343 folds them into the combined Policy view later).
- Component tests for both, following `budgets-view` / `exceptions-view`.

### Phase 3 — inherited-vs-local on the per-user Budgets view

- `BudgetsView.svelte`: also load `listUserGroups()`; if any groups exist,
  fetch `listResolvedBudgets(userId)` per user in parallel and collect the
  `source.kind === "group"` slots (the inherited-not-overridden ones).
- Add a **Source** column: own rows → "Local"; append read-only inherited rows
  tagged "Inherited · <group name>" (no edit/delete — not the user's own).
- Update `budgets-view` component test for the new column + inherited rows.

## Guardrails

- License boundary: none touched — plain TS + zod + Drizzle reads + Svelte. No
  GPL import, no image change.
- No new dependency.
- `tsc --noEmit` clean, no `any`/`as`/`@ts-ignore`, coverage ≥ 80%.

## Deferred / out of scope (tracked)

- #343 combined Policy view composition (this issue's placement note).
- #141 weekday-varying group budgets (extends the same editor later).
- Threading budget `source` into the enforcement/effective resolver output is
  intentionally *not* done — a separate read endpoint keeps this display-only.
