# Plan — #133 Collision-resistant drizzle migrations (timestamp prefix)

Roadmap: `docs/roadmap.md` → Phase 1 (project scaffolding / CI baseline).

## Problem

drizzle-kit's default `index` prefix numbers migrations sequentially
(`0000_`, `0001_`, …). Two sessions branching off the same `main` each
generate the **same filename** (`000N_.sql`, `meta/000N_snapshot.json`), so
whoever merges second hits an add/add conflict and has to renumber +
regenerate by hand. This bit PR #123 twice in one session.

## Fix (drizzle translation of next-digital-wall-calendar#346)

1. **`drizzle.config.ts`** — set `migrations: { prefix: "timestamp" }` so new
   migrations are named `<YYYYMMDDHHmmss>_<slug>` for both the SQL file and the
   snapshot. Two concurrent branches then produce non-colliding filenames; the
   only residual merge is appending each branch's entry to `_journal.json`
   (a trivial textual append, not a clobber). One-line comment → this issue.

2. **CI naming check** — a pure, unit-tested guard
   (`tests/policy/migration-naming.ts`) plus a suite
   (`tests/policy/migration-naming.test.ts`) that runs in the existing unit
   CI job (`.github/workflows/ci.yml` → `test`). It validates that every
   migration the journal references matches **either** the legacy index prefix
   (`^[0-9]{4}_…`, grandfathered structurally — not via a hardcoded list, so
   another pre-convention index migration merging to `main` mid-PR doesn't
   re-break CI) **or** the timestamp convention `^[0-9]{14}_[a-z0-9_]+$`, and
   flags two timestamp migrations that share the same second. The
   `prefix: "timestamp"` config is what prevents *new* index migrations.
   Implemented as a vitest test rather than a standalone runner so
   no new tooling/dependency (e.g. `tsx`) is added — the check runs wherever
   `npm test` runs, and the logic is unit-tested directly.

3. **Drift gate stays** — `db:check` / `.github/workflows/integration.yml`'s
   `migrations` job is untouched; it remains the backstop for *semantic*
   conflicts (two independent schema edits) that timestamps don't address.

4. **Docs** — record the convention in `docs/testing.md` (migrations section)
   and `CLAUDE.md` (migrations bullet) so future sessions generate with the
   timestamp prefix.

## Out of scope

- No migration tooling swap (stays better-sqlite3 + drizzle-kit per `CLAUDE.md`).
- Existing `0000_`/`0001_` migrations are left as-is (drizzle orders by the
  journal's `idx`/`when`; mixed prefixes coexist).
- Logically-conflicting schema edits still need human resolution; the drift
  gate surfaces those.

## License-boundary note

N/A — config option, a test-only TypeScript guard, and docs. No GPL linkage,
no transport, no Docker-image/packaging change. `license-guard` unaffected.

## Test plan

- Unit: empty journal; grandfathered-only; valid timestamp tags;
  grandfathered + timestamp mix; a *new* index-prefixed tag → violation;
  a malformed tag → violation; duplicate same-second timestamps → violation.
- Repo guard: parse the real `drizzle/meta/_journal.json`, assert zero
  violations, and assert each journal tag has its `<tag>.sql` and
  `<prefix>_snapshot.json` with no stray SQL files.
