# Issue #229 — Reserve a `platform` column on `Client`

Roadmap: `docs/roadmap.md` → Phase 2 (policy schema). Cross-platform
groundwork from `docs/windows-client-support.md` → "Modularity tweaks to
make cheaply now" (item 1). Mirrors the recurrence-column reservation
(#146) and the `activities.match_type` reservation (#178/ADR 0006): add a
defaulted discriminator column now so backfilling a `platform` over a live
fleet is never required.

## Goal

Add a `platform` column to the `clients` table — `linux` today, `windows`
reserved — defaulted to `linux`, constrained to a small enum, and surfaced
read-only on the client DTOs so the admin UI can show a per-client OS
badge. **No Windows behaviour** — this is purely the reserved
discriminator.

## Non-goals

- No Windows-specific enforcement/transport (post-Phase-14 epic #233).
- No capability-keyed transport dispatch (its own follow-up, #232).
- The enrol request does **not** accept a platform yet — every enrolment
  is `linux`; the column carries it. ("Enrolment may set it; until a
  Windows client exists it is always `linux`.")

## Phases

### Phase 1 — schema + migration + storage tests

1. `src/policy/enums.ts`: add `platformValues = ["linux", "windows"]`,
   `platformSchema`, `Platform`, documented like the sibling enums
   (`windows` reserved for the post-Phase-14 epic; default `linux`).
2. `src/policy/schema.ts`: add
   `platform: text("platform", { enum: platformValues }).notNull().default("linux")`
   to `clients`, plus `check("clients_platform_check", oneOf(...))`.
   Extend the `clients` table doc comment.
3. `npm run db:generate` → migration. Adding a CHECK forces a SQLite
   table-recreate (drizzle-kit limitation); hand-fix the `INSERT … SELECT`
   to copy only pre-existing columns so existing rows take the
   `DEFAULT 'linux'` (same pattern as `messy_sleepwalker`/`match_type`).
   `npm run db:check` clean.
4. Tests:
   - `tests/policy/enums.test.ts`: platform tuple/zod coverage.
   - `tests/policy/schema.test.ts`: defaults to `linux`; rejects an
     off-tuple value (CHECK); accepts `windows`.
   - `tests/policy/migrations.test.ts`: `clients.platform` exists,
     NOT NULL, default `'linux'`; a row inserted without it lands on
     `linux`; `EXPECTED_TABLES` unchanged.

### Phase 2 — DTO surfacing + tests

1. `src/api/policy/dtos.ts`: add `platform: platformSchema` to
   `clientResponseSchema`; map `row.platform` in `toClientResponse`.
2. `src/api/clients/dtos.ts`: add `platform` to `enrolResponseSchema`
   (read-only, always `linux` for now).
3. `src/api/clients/service.ts`: include `platform: result.client.platform`
   in the enrol response.
4. Tests: extend the existing policy-routes/clients DTO tests to assert
   `platform` round-trips as `linux`.

## License boundary

N/A — plain TypeScript + zod + Drizzle (Apache-2.0) / better-sqlite3
(MIT). No GPL linkage, no transport/REST boundary, no Docker-image change.

## Quality gate

`format:check`, `lint`, `typecheck`, `npm test` (coverage ≥ 80%),
`db:check` — all green per phase.
