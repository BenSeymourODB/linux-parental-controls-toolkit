# Plan — #225: decompose `registerPolicyRoutes` & dedupe PATCH payload building

**Issue:** #225 (code-review, complexity, Medium). `server/src/api/policy/routes.ts`
is the largest module in the repo (~1551 lines). `registerPolicyRoutes` is a
single ~1330-line function that registers 5–7 CRUD endpoints for each of ~13
entities. It is repetitive, not algorithmically complex. Two concrete PATCH
duplications: Schedule PATCH ↔ GroupSchedule PATCH build identical
update-payloads; Exception PATCH ↔ GroupException PATCH likewise.

**Tracking epic:** #308 (decompose oversized policy-layer modules).

## Constraints

- **Behaviour-preserving.** No route path, status code, error envelope, push
  fan-out, or validation changes. The existing `tests/api/*` suites are the
  guard and stay green **unchanged**.
- **Public surface preserved.** `notFound`, `assertFound`, `assertRemoved` are
  currently `export`ed from `routes.ts` and imported by
  `tests/api/policy-not-found-helpers.test.ts` from `./routes.js` — they must
  remain importable from that path.
- No GPL/licensing surface touched — pure TypeScript + zod + Drizzle.
- No new dependency.

## Layering note (deviation from the issue's suggestion)

The issue suggests the shared update-payload helper live "in
`policy/repository.ts`". Its input is the parsed **API request body**
(`UpdateScheduleRequest` / `UpdateExceptionRequest`, inferred from the
`api/policy/dtos.ts` zod schemas). Putting it in `policy/repository.ts` would
make the `policy/` layer depend on the `api/` layer — backwards, and a possible
import cycle. So the builders live in the new `api/policy/routes/shared.ts`
(the API layer, where the request body is already an API concern) and return
the `repo.ScheduleUpdate` / `repo.ExceptionUpdate` types the repository accepts.
The dedup and single-source normalization the issue asks for are achieved; only
the file home differs. Recorded here and in the PR.

## Phase 1 — extract shared helpers + PATCH-payload builders

New file `server/src/api/policy/routes/shared.ts` housing what is today
module-private-or-exported at the top of `routes.ts`:

- `asConflict`, `asValidated` — repository-write → 409/400 mappers.
- `notFound`, `assertFound`, `assertRemoved` — 404 helpers (re-exported from
  `routes.ts` for the existing importer).
- `assertTarget` — the polymorphic-target invariant guard.
- `groupMemberPushCommands` — group-rule push fan-out.
- **New:** `nullableDate(iso)` — the single `string | null → Date | null`
  timestamp normalization.
- **New:** `buildScheduleUpdatePatch(body): repo.ScheduleUpdate` and
  `buildExceptionUpdatePatch(body): repo.ExceptionUpdate` — the conditional
  field-inclusion + timestamp normalization the four PATCH handlers duplicate.
  `ScheduleUpdate ≡ GroupScheduleUpdate` and `ExceptionUpdate ≡
  GroupExceptionUpdate` structurally, so one builder each serves the user- and
  group-targeted handler.

`routes.ts` imports these, uses the two builders in the four PATCH handlers,
uses `nullableDate` in the create paths, and re-exports the three public 404
helpers. New unit test `tests/api/policy-update-patch-builders.test.ts` covers
the builders directly (each field included only when present; `null` passthrough
for `targetId`/`effective*`; `effectiveFrom`/`effectiveTo`/`expiresAt` → `Date`;
empty body → empty patch).

Gate green → commit → push (opens the draft PR).

## Phase 2 — split into per-entity registrars

New directory `server/src/api/policy/routes/`, one registrar per entity, each
`export function register<Entity>Routes(scope: FastifyInstance, push:
PolicyPushStub): void` deriving its own `typed = scope.withTypeProvider<…>()`
and `guard`:

- `users.ts`, `clients.ts`, `links.ts`
- `activities.ts`, `activity-groups.ts` (groups + activity membership)
- `user-groups.ts` (groups + user membership)
- `group-schedules.ts`, `group-exceptions.ts`, `group-budgets.ts`
- `budgets.ts`, `schedules.ts`, `exceptions.ts`
- `notification-policy.ts`

`routes.ts` becomes a thin composition: build the push stub once, call each
registrar in the original registration order (order matters for Fastify route
matching — flat `/group-schedules/:id` etc. are already distinct paths, but
order is preserved to be safe), and re-export the three 404 helpers.

Gate green → commit → push.

## Validation (each phase, from `server/`)

`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test`
(coverage gate 80%). The route suites in `tests/api/` exercise every endpoint
and are the behaviour guard.
