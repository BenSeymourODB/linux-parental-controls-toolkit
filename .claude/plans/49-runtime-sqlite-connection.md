# Plan — #49 Runtime SQLite connection (better-sqlite3 + Drizzle) and migrate-on-start

Roadmap: `docs/roadmap.md` → Phase 2. Blocks #51 (CRUD over `app.db`), #52
(admin credential persistence). Builds on merged #48 (schema + first
migration), #34 (`DATABASE_URL` contract), #12 (`testDb()`), #9 (drizzle
scaffold).

## Goal

Wire a **live** `better-sqlite3` + drizzle-orm connection into the running
app. Today `buildApp()` never opens `settings.databaseUrl`; the only DB handle
that exists is the in-memory `testDb()` test helper. Give routes and the
policy service one shared `app.db` handle, migrated on boot, closed cleanly on
shutdown.

## Key decisions

1. **Migrate in-process on boot, not in the entrypoint.** `createDb()` applies
   the committed migrations via drizzle-orm's `better-sqlite3` migrator (which
   reads the SQL the Dockerfile already copies to `/app/drizzle`). This keeps
   `drizzle-kit` (a dev dependency) out of the runtime image, per #39's
   Phase-2 note, and means the entrypoint does **not** also migrate — so the
   two can never double-migrate or disagree on the path (AC #4). The migrator
   is idempotent (drizzle's `__drizzle_migrations` journal). This is a change
   to a documented step, so `docs/server-deployment.md` first-run step 1 and
   the `docker-entrypoint.sh` comment are updated in this PR.

2. **`databaseUrl` is consumed as-is** — the settings loader (#34) already
   strips a leading `file:` to a bare path, which is what `better-sqlite3`
   wants. `createDb` does no further URL handling.

3. **`buildApp` owns the DB it creates.** When no `db` is injected, `buildApp`
   calls `createDb(settings)` and closes that handle on `app.close()`. When a
   `db` is injected (tests via `buildTestApp`), the injector owns its lifecycle
   and `buildApp` does not close it — no double-close.

## Phases

### Phase 1 — `createDb()` + the typed `PolicyDb` handle (+ tests, docs)

- New `server/src/policy/db.ts`:
  - `createDb(settings, options?)`: opens `settings.databaseUrl`, sets
    `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`, wraps in
    drizzle with the full `schema`, applies migrations, returns the handle.
  - `export type PolicyDb` = `BetterSQLite3Database<typeof schema>` with the
    `$client` better-sqlite3 handle exposed (mirrors `TestDb`).
  - Migrations folder resolved relative to the module (`../../drizzle`), which
    is `<root>/drizzle` both from `src/policy/` (tests) and `dist/policy/`
    (image) — same trick the test helper and `migrations.test.ts` use. An
    `options.migrationsFolder` override keeps it testable.
- Tests `server/tests/policy/db.test.ts`: opens against a real temp file
  (WAL pragma is meaningful on-disk), asserts `foreign_keys = ON`,
  `journal_mode = wal`, the full schema is materialised, FK violations are
  rejected, and re-opening the same file is a no-op (no re-migrate).
- Docs: `docs/server-deployment.md` first-run step 1 + `docker-entrypoint.sh`
  comment — migration runs in-process at server boot, not via `drizzle-kit` in
  the entrypoint.

### Phase 2 — `app.db` decorator wiring (+ tests, docs)

- `server/src/web/app.ts`: add `db?: PolicyDb` to `BuildAppOptions`; module-
  augment `FastifyInstance` with `db: PolicyDb`; decorate; create-and-own when
  not injected; `onClose` closes only an owned handle.
- `tests/helpers/app.ts`: pass the bundled `db` through to `buildApp` (drops
  the forward-compat note).
- Update the three direct-`buildApp` route/logging/frontend tests to inject a
  `testDb()` so they don't try to open `/data/policy.sqlite`.
- `tests/web/app.test.ts` (or a new `tests/web/db.test.ts`): assert `app.db` is
  decorated, usable (insert + select a `users` row), and that an owned handle
  is closed on `app.close()` while an injected one is left open.
- Docs: drop the Phase-1 status caveat in `docs/testing.md` (lines ~215-219).

## Quality gate (run from `server/` after each phase)

`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test`
(coverage ≥ 80 %; `src/policy` target 90 %).

## License-boundary note

No GPL linkage: better-sqlite3 (MIT) and drizzle-orm (Apache-2.0) only. No new
dependency. No change to the image's GPL posture (migrations SQL already
shipped; no new binaries).
