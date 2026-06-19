# Plan — #51 `/api/*` policy CRUD (slice 1: accounts + devices)

Roadmap: `docs/roadmap.md` → Phase 2 ("`/api/*` JSON endpoints for the full
policy model"). Umbrella issue #51 explicitly allows landing as per-entity
follow-up PRs, each with tests.

## Scope of this PR

CRUD for the **account/device core** — the foundational entities every other
policy row references by FK:

- `User` (`/api/users`)
- `Client` (`/api/clients`)
- `UserOnClient` link (`/api/users/:userId/clients/:clientId`)

Deferred to their own follow-up PRs under #51 (tracked issues, linked from the
PR): `Activity` + `ActivityGroup` (+ the M2M), `Budget`, `Schedule`,
`Exception`. `Grant` / `IntegrationToken` writes are explicitly Phase 10 (out
of scope per the issue).

## Why this slice

`User` and `Client` are referenced by FK from `budgets`, `schedules`,
`exceptions`, `usage_samples`, `grants`, `users_on_clients`. Landing them first
gives the later per-entity PRs something to reference and lets the admin UI
(#53) build the users/clients screens immediately.

## Design (follows the merged #50/#52 conventions)

- **DTOs** — zod schemas in `server/src/api/policy/dtos.ts`, reusing the shared
  enums (`enums.ts`) and the error envelope (`api/errors.ts`). `tz` validated
  with `isValidTimeZone` (ADR-0001) so a bad IANA name is a 400, not a stored
  bad value. Response DTOs serialize epoch-second `Date` columns as ISO-8601
  strings; types are inferred and shared with the frontend.
- **Repository** — pure data-access functions in
  `server/src/policy/repository.ts` taking the injected `PolicyDb` ("reads and
  writes go through the policy service over `app.db`", `CLAUDE.md`). No HTTP
  concerns here; unique-violation detection exposed as `isUniqueViolation()`
  for the route layer to map to 409.
- **Routes** — `server/src/api/policy/routes.ts`, registered inside the `/api`
  plugin **after** `registerAuth` so every route sits behind
  `app.requireAdmin` (anonymous → 401 envelope). Mutations map:
  - missing row on GET/PATCH/DELETE → `404 not_found`
  - duplicate `hostname` / duplicate `(client, linux_uid)` → `409 conflict`
  - empty PATCH body / bad field → `400 validation_error`
  - link PUT to a non-existent user or client → `404 not_found`

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/users` | list |
| POST | `/api/users` | create (201) |
| GET | `/api/users/:id` | 404 if missing |
| PATCH | `/api/users/:id` | partial; `tz: null` clears |
| DELETE | `/api/users/:id` | 204; cascades links |
| GET | `/api/clients` | list |
| POST | `/api/clients` | create (201); dup hostname → 409 |
| GET | `/api/clients/:id` | |
| PATCH | `/api/clients/:id` | dup hostname → 409 |
| DELETE | `/api/clients/:id` | 204; cascades links |
| GET | `/api/users/:userId/clients` | list a user's links (404 if user missing) |
| PUT | `/api/users/:userId/clients/:clientId` | upsert link; dup uid → 409 |
| DELETE | `/api/users/:userId/clients/:clientId` | 204; 404 if link missing |

## Tests

- `tests/policy/repository.test.ts` — unit, against `testDb()`: CRUD round-trips,
  cascade on user/client delete, unique-violation detection, link upsert.
- `tests/api/policy.test.ts` — `app.inject()` through `buildTestApp` with a real
  login cookie: per entity happy path + a validation-failure path + anonymous
  401; plus 404 and 409 paths.

## License boundary

N/A — pure TypeScript + zod + Drizzle (`better-sqlite3`/`drizzle-orm`, already
deps). No transport, no subprocess, no packaging change. No new dependency.
