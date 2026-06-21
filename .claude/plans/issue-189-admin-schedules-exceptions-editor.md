# Plan — Admin UI: Schedules / Exceptions editor (#189, follow-up of #53)

## Context

`#189` is the follow-up tracking the remaining `/admin` policy editors after the
`#53` foundation slice. Already merged to `main`:

- Foundation slice (#53): typed `/api` client, login/session, `/admin` shell,
  Users editor.
- Slice 1 (#189): Clients, Activities.
- Slice 2 (#189, PR #244): Activity Groups (+ membership), Budgets, User↔Client
  links.

The **only** `/admin` editor still missing is **Schedules / Exceptions** — this
slice. It closes out #189's CRUD scope.

## Boundaries (explicit — do not cross)

- **Recurring day-of-week + intra-day window authoring → #140.** This editor
  creates the always-on degenerate schedule (all recurrence fields `null`) and
  **renders** recurrence read-only so rules a future #140 editor authors still
  display. No day-mask / time-window inputs here.
- **Drag-to-order + first-match-wins (ordinal) → #63.** No reordering UI;
  `ordinal` left at the column default on create.
- **Group-targeted rules → #182 (PR #203, additive, separate tables/routes).**
  This editor talks to the stable per-user `/api/schedules` + `/api/exceptions`
  contract already on `main`; it is unaffected by #203.

These match the carve-outs stated in #189's body and the slice-2 deferral note.

## Contract (already on `main`, `server/src/api/policy/`)

`/api/schedules` (+ `/:id`) and `/api/exceptions` (+ `/:id`) — full CRUD, guarded
by `requireAdmin`, `?userId=` list filter. DTOs in `api/policy/dtos.ts`:

- **Schedule**: `userId`, `targetKind` (`overall|activity|group`), `targetId`,
  `action` (`allow|deny|extend`), recurrence fields (all nullable; created
  `null`), `ordinal`.
- **Exception**: `userId`, `targetKind`, `targetId`, `action`, `reason`
  (nullable), `effectiveFrom` (nullable ISO), `expiresAt` (required ISO),
  `createdAt`. Exception date bounds are **one-shot**, not recurrence — authoring
  them is in scope.

## Established frontend pattern (mirror exactly)

- `src/lib/api/contract.ts` — `import type` re-exports of inferred zod DTO types.
- `src/lib/api/<entity>.ts` — thin `apiFetch` wrappers (see `budgets.ts`).
- `src/lib/views/<Entity>View.svelte` — list/create/inline-edit/delete (Svelte 5
  runes, browser-only `onMount` load, inline error surface).
- Nav wiring in `src/routes/admin/+page.svelte`.
- `tests/api/<entity>.test.ts` — vitest, `fetch` spy asserting URL/method/body.

## Work phases

### Phase 1 — typed API layer + contract types + tests
1. `contract.ts`: add `ScheduleResponse/CreateScheduleRequest/UpdateScheduleRequest`,
   `ExceptionResponse/CreateExceptionRequest/UpdateExceptionRequest`, and the
   `ScheduleAction` enum type to the re-exports.
2. `src/lib/api/schedules.ts` + `src/lib/api/exceptions.ts` — `list(userId?)`,
   `create`, `update(id)`, `delete(id)` (mirror `budgets.ts`, incl. `?userId=`).
3. `tests/api/schedules.test.ts` + `tests/api/exceptions.test.ts`.

### Phase 2 — views + nav wiring
4. `SchedulesView.svelte`: create (user + scope + activity/group target + action;
   recurrence created always-on), table with read-only recurrence summary
   ("Always" when degenerate), inline edit of `action`, delete with confirm.
5. `ExceptionsView.svelte`: create (user + scope + target + action + reason +
   optional `effectiveFrom` + required `expiresAt` via `datetime-local`), table,
   inline edit of `action` + `expiresAt` (+ `reason`), delete with confirm.
6. Wire two nav items ("Schedules", "Exceptions") + imports + view switch in
   `+page.svelte`.

### Phase 3 — validate
7. `npm run format`, `lint:fix`, `typecheck`, `npm test` (server gate, 80%).
8. `cd server/frontend && npm ci && npm run check && npm run build` green.

## Helpers / care points

- `datetime-local` ⇄ ISO-8601 UTC: `new Date(local).toISOString()` to send;
  ISO → local input value for edit prefill. `z.string().datetime()` requires a
  trailing `Z`, which `toISOString()` produces.
- Scope→target picker: clear `targetId` on scope change; `overall` sends `null`.
- Errors surfaced inline via `ApiError.message` (same `messageOf` helper as the
  other views).

## Out of scope / deferred (note in PR, link issues)
- Recurrence authoring → #140. Ordinal/drag-reorder → #63. Group targeting → #182.
- Deep `/admin/*` routes + SPA fallback → #59.
