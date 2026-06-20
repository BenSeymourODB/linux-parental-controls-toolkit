# Issue #199 — Tooling: auto-rebase a branch's Drizzle migration (Slice 1)

Roadmap: `docs/roadmap.md` → Phase 11 (cross-cutting dev tooling). No
license-boundary or tamper-resistance surface.

## Problem (from the issue)

Timestamp-prefixed migration *filenames* (#133) no longer collide, but each
migration snapshot carries a `prevId` parent pointer. Two branches that branch
off the same snapshot generate migrations whose snapshots claim the **same
parent**, so merging `main` in produces a drizzle-kit "pointing to a parent
snapshot … which is a collision" error that the `migrations` CI job catches.

The reliable manual fix: drop the branch-only migration(s) + their snapshots,
trim the `_journal.json` entries, then re-run `db:generate` against the merged
base so the new migration chains off the latest snapshot.

## Scope — Slice 1 only

`npm run db:rebase` (a `node --experimental-strip-types` CLI; no new dep) that:

1. Refuses if there are **unresolved merge conflicts** — `git diff
   --diff-filter=U` is non-empty, or conflict markers remain in
   `_journal.json` / `src/policy/*.ts`. Regen fixes migration *artifacts*, not
   the source merge.
2. Computes branch-only migrations from
   `git diff --name-only origin/main...HEAD -- 'drizzle/*.sql'`.
3. **Safety guard** — refuse (unless `--force`) when:
   - there is **more than one** branch-only migration (regen collapses them
     into one cumulative diff — lossy), or
   - after regen the new SQL is **not equivalent** to the branch-only SQL it
     replaced (hand-edited / custom data SQL — e.g. the #146 recurrence
     recreate locked by `tests/policy/migrations.test.ts`). On this detection
     without `--force`, **restore** the original artifacts via git and abort.
4. `rm` the branch-only `.sql` + their `meta/<prefix>_snapshot.json`; trim the
   matching `_journal.json` entries.
5. `npm run db:generate`, then `npm run db:check`.
6. Leave the result **staged, not committed** (a review gate on schema changes).

## Design — where the code lives

- Tool: `server/scripts/rebase-migrations.ts` — a **single self-contained**
  file (imports only node builtins, so `--experimental-strip-types` needs no
  cross-`.ts` resolution). Pure helpers + an orchestrator taking injected
  `git` / fs / `runScript` / `log` seams (mirrors the offline-queue injected-
  seam pattern), plus a `main()` guarded by an `import.meta.url` check.
- Excluded from the Docker image: not under `src/`, and `tsconfig.build.json`
  only includes `src/**`. Added to `tsconfig.json` `include` so `typecheck`
  and ESLint still cover it.
- `package.json`: `"db:rebase": "node --experimental-strip-types
  scripts/rebase-migrations.ts"`.

## Tests — `server/tests/scripts/rebase-migrations.test.ts`

Pure functions tested directly; the orchestrator tested with in-memory fakes
for every seam, covering: no-op (no branch-only migrations), happy single-
migration rebase, refuse-on-conflict-markers, refuse-on-unmerged-paths,
refuse-on->1-migration (and `--force` override), hand-edit detection +
restore, and the `db:check` failure path.

## Deferred → follow-up issue

Slice 2 (opt-in CI auto-fix workflow on `claude/**` PR `synchronize`: push-loop
prevention, hand-edit protection, write-scoped token) is filed as a separate
issue and linked from the PR. #199 stays open for it; this PR is _Part of #199_.
