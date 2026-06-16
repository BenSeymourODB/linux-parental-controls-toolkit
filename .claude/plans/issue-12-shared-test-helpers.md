# Issue #12 — Shared test helpers (`server/tests/helpers/`)

Roadmap: Phase 1 groundwork. Land the helpers `docs/testing.md` already
documents so Phase 2 / Phase 4 PRs don't each re-invent them. Prerequisites
#5 (`buildApp()`) and #9 (drizzle migrations scaffold) are merged on `main`.

## Helpers

1. **`tests/helpers/db.ts` — `testDb()`**
   - Fresh in-memory better-sqlite3 DB, `drizzle()`-wrapped, with the
     committed migrations applied via `drizzle-orm/better-sqlite3/migrator`.
   - Resolve the migrations folder relative to the helper file (not cwd),
     mirroring `tests/policy/migrations.test.ts`, so it is runner-cwd
     independent.
   - Phase-1 journal is empty (no tables yet); the migrator only provisions
     its bookkeeping table. The helper keeps working unchanged once Phase 2
     adds real tables.
   - Returns the Drizzle db directly (matching the documented
     `buildApp({ db: testDb() })` contract); the underlying handle is
     reachable via `db.$client` for explicit `.close()`.

2. **`tests/helpers/app.ts` — `buildTestApp()`**
   - Wraps `buildApp()` (#5) with a silent logger and bundles a `testDb()`.
   - Returns `{ app, db, close() }`; `close()` shuts the Fastify app and the
     in-memory DB so route tests stay hermetic.
   - Forward-compatible: `buildApp()` does not yet accept a `db` option (that
     runtime DB wiring lands in Phase 2 — see #34/#39). For now the db is
     created and returned alongside the app; the pass-through into `buildApp`
     lands with the Phase-2 connection work. Documented in the helper.

3. **`tests/helpers/subprocess.ts` — `mockSubprocess()`**
   - Wraps the `vi.mock("node:child_process")` pattern from
     `docs/testing.md` → "Mock patterns by layer". Provides `vi.fn()` mocks
     for `execFile`/`spawn`, the `module` object to hand back from the mock
     factory, and `execFileCalls()` / `spawnCalls()` recorders that normalise
     `.mock.calls` into `{ command, args }`. Used by Phase-4 transport tests.
   - Intended usage: `const sp = vi.hoisted(() => mockSubprocess()); vi.mock("node:child_process", () => sp.module);`

## Tests

One smoke test per helper under `tests/helpers/` confirming wiring:
`db.test.ts` (migrations apply, bookkeeping table exists), `app.test.ts`
(`app.inject()` hits `/healthz`, db is usable, `close()` works),
`subprocess.test.ts` (a mocked `execFile` call is intercepted and recorded).

Helpers live under `tests/` so they are excluded from coverage
(`include: ["src/**"]`); the smoke tests keep the gate green without
touching `src/`.

## License-boundary note

N/A — test-only helpers. `mockSubprocess` reinforces the subprocess boundary
(it never invokes a real GPL binary). No transport/packaging/image changes.
