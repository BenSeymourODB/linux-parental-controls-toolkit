# Plan — #148 `/api/*` policy CRUD, remaining entities

Follow-up slice of the #51 umbrella. Slice 1 (`User`/`Client`/`UserOnClient`)
landed. This PR adds CRUD for **all** remaining policy-model entities, so it
closes #148 and #51:

- `Activity`
- `ActivityGroup` + `activities_to_groups` membership
- `Budget`
- `Schedule` — built against the recurrence + date-scoping shape finalized by
  #146 / PR #156 (merged mid-session); reuses `scheduleRecurrenceSchema`.
- `Exception` — `effective_from`/`expires_at` window per ADR 0005.

> **Scope note.** This PR was initially scoped to Activity/ActivityGroup/Budget
> while #146 (PR #156) was reshaping the `schedules`/`exceptions` tables. #156
> merged during the session, so Schedule/Exception were folded back in against
> the final shape (the branch was rebased onto the merge).

## Conventions reused (from slice 1)

- DTOs in `server/src/api/policy/dtos.ts`, reusing `policy/enums.ts`
  (`activityKindSchema`, `scopeSchema`, `budgetWindowSchema`,
  `scheduleActionSchema`) and `policy/recurrence.ts`
  (`scheduleRecurrenceSchema`). Types inferred, never hand-written twice.
- Repository in `server/src/policy/repository.ts` over `app.db`; reuse
  `isUniqueViolation()` (→ 409) and add `isCheckViolation()` (→ 400).
- Routes in `server/src/api/policy/routes.ts`, behind `requireAdmin`. Thin
  handlers: validate via DTO, delegate to repo, map missing → 404, unique
  collision → 409, CHECK/coherence violation → 400.
- Barrels re-export the new DTOs from `api/policy/index.ts` and `api/index.ts`.
- Push stub (#54): `budget.*`/`schedule.*`/`exception.*` are user-scoped
  reasons (fan out to the user's linked clients). Activity/ActivityGroup are
  definitions and do not push.

## Validation strategy

- **Coherence + referent** (`scope`/`target_kind` ↔ `target_id`, and the
  referenced activity/group must exist) is one route helper, `assertTarget`,
  shared by create and PATCH so the rule lives in one place.
- **Create** bodies validate fully at the DTO (enum bounds, recurrence
  invariants via `scheduleRecurrenceSchema`, exception window via superRefine).
- **PATCH** validates per-field bounds at the DTO and re-checks coherence on
  the merged row in the route; the cross-field recurrence/window invariants a
  partial PATCH can break are backstopped by the storage `CHECK` constraints,
  mapped to a clear 400 (`asValidated`) rather than a generic 500.

## Route surface

- `GET/POST /api/activities`, `GET/PATCH/DELETE /api/activities/:id`
- `GET/POST /api/activity-groups`, `GET/PATCH/DELETE /api/activity-groups/:id`
- `GET /api/activity-groups/:groupId/activities`,
  `PUT/DELETE /api/activity-groups/:groupId/activities/:activityId`
- `GET/POST /api/budgets` (`?userId=` filter), `GET/PATCH/DELETE /api/budgets/:id`
- `GET/POST /api/schedules` (`?userId=`), `GET/PATCH/DELETE /api/schedules/:id`
- `GET/POST /api/exceptions` (`?userId=`), `GET/PATCH/DELETE /api/exceptions/:id`

## Tests

- Repository unit tests (CRUD round-trips, FK/cascade, idempotent membership,
  ordering, `CHECK` backstops) in `tests/policy/repository.test.ts`.
- `app.inject()` route tests (happy + validation + 404 + 409 + coherence +
  PATCH CHECK backstops) in `tests/api/policy.test.ts`.
- DTO mapper tests in `tests/api/policy-dtos.test.ts`.
- Push-stub tests for the new user-scoped reasons in
  `tests/api/policy-push-stub.test.ts`.

## License boundary

N/A — plain TypeScript + zod + Drizzle (Apache-2.0) + better-sqlite3 (MIT).
No transport, packaging, Docker-image, or GPL surface. `license-guard`
unaffected.
