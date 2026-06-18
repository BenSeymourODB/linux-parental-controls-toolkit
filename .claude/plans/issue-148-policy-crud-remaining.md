# Plan — #148 `/api/*` policy CRUD, remaining entities

Follow-up slice of the #51 umbrella. Slice 1 (`User`/`Client`/`UserOnClient`)
landed. This PR adds CRUD for **all** remaining policy-model entities, so #148
(and the #51 umbrella) can close:

- `Activity`
- `ActivityGroup` + `activities_to_groups` membership
- `Budget`
- `Schedule` — against the recurrence + date-scoping shape finalized by #146
  (PR #156, merged), reusing `policy/recurrence.ts`' `scheduleRecurrenceSchema`
- `Exception` — `effective_from`/`expires_at` window per ADR 0005

> Scope history: an earlier revision deferred Schedule/Exception while PR #156
> was reshaping those tables. #156 merged mid-session, so this PR was rebased
> onto it and expanded to the full slice.

## Conventions reused (from slice 1)

- DTOs in `server/src/api/policy/dtos.ts`, reusing `policy/enums.ts` +
  `policy/recurrence.ts` and the shared error envelope. Types inferred.
- Repository in `server/src/policy/repository.ts` over `app.db`; `isUniqueViolation()`
  (→ 409) plus a new `isCheckViolation()` (→ 400) for storage-CHECK backstops.
- Routes in `server/src/api/policy/routes.ts`, behind `requireAdmin`. Thin
  handlers: validate via DTO, delegate to repo, map missing → 404, unique
  collision → 409, coherence/CHECK violation → 400.
- Barrels re-export new DTOs from `api/policy/index.ts` and `api/index.ts`.
- Push stub (#54): `budget.*` / `schedule.*` / `exception.*` are user-scoped
  reasons (fan out to the user's linked clients). Activity/ActivityGroup are
  definitions with no per-client effect → no push.

## Validation strategy

- **Create** bodies validate fully at the DTO (enum/bounds, recurrence
  invariants via `scheduleRecurrenceSchema`, exception `effectiveFrom < expiresAt`).
- **Target coherence + referent existence** (polymorphic `target_id`) is one
  route helper `assertTarget(db, kind, targetId)` shared by create and PATCH →
  precise 400.
- **PATCH** cross-field invariants that depend on the merged row (half-open
  recurrence pair, exception window) are backstopped by the storage `CHECK`
  mapped to 400 via `asValidated()`, so a partial update can never 500.

## Phases

1. Repository + DTOs + push-stub + barrels (this PR's source).
2. Tests: repository unit (incl. FK/cascade + CHECK), `app.inject()` route
   tests per entity (happy + validation + 404 + 409 + coherence + merged-row
   backstop), DTO mappers, push-stub assertions.
3. Quality gate + finalize, ready-for-review.

## License boundary

N/A — plain TypeScript + zod + Drizzle (Apache-2.0) + better-sqlite3 (MIT).
No transport, packaging, Docker-image, or GPL surface. `license-guard`
unaffected.
