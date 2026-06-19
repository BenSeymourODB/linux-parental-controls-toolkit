# Issue #34 — Reconcile the `DATABASE_URL` contract

## Problem

Two Phase-1 contracts disagree on the shape of `DATABASE_URL`:

- **`file:` (libsql) form** — CI `integration.yml` (`migrations` job) sets
  `DATABASE_URL: file:./ci_migration_test.sqlite`, and `drizzle.config.ts`
  defaults to `file:./policy.sqlite` and **strips** the `file:` scheme
  because `better-sqlite3` wants a bare filesystem path.
- **bare-path form** — `server/src/config.ts` (`loadSettings`) stores the
  value **verbatim** (default `/data/policy.sqlite`); `.env.example` shows a
  bare path.

Nothing breaks today (no live `better-sqlite3` consumer), but in Phase 2 the
runtime opens the DB from `settings.databaseUrl`. `better-sqlite3` does not
understand `file:` URIs, so an operator following the CI/#33 convention
(`DATABASE_URL=file:/data/policy.sqlite`) would have migrations and the
runtime point at **different files**.

## Decision — Option 1 (the issue's recommendation)

Normalize a leading `file:` scheme in the settings loader so both forms
resolve to the same `better-sqlite3` path. Mirror the exact strip
`drizzle.config.ts` already uses (`/^file:/`) so the two stay in lockstep.
`drizzle.config.ts` and CI are left untouched.

## Changes

1. `server/src/config.ts` — strip a leading `file:` from `databaseUrl` via a
   zod `.transform` (runs after `.default`, so the default and any
   `file:`-prefixed value both normalize). Keep the field a plain `string`.
2. `server/tests/config.test.ts` — add cases: `file:./policy.sqlite` →
   `./policy.sqlite`, `file:/data/policy.sqlite` → `/data/policy.sqlite`,
   bare path unchanged, default unchanged.
3. `server/.env.example` — one-line note that a `file:` prefix is accepted
   and stripped, so the CI/drizzle `file:` form and a bare path are
   equivalent.
4. `docs/server-deployment.md` — document the single `DATABASE_URL` contract
   in the Volume-layout / database paragraph.

## Out of scope

- Touching `drizzle.config.ts` or CI (Option 1 deliberately leaves them).
- Wiring the runtime `better-sqlite3` connection (Phase 2, #39).
