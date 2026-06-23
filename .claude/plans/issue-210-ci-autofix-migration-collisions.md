# Issue #210 — CI auto-fix for Drizzle migration snapshot collisions (Slice 2 of #199)

Roadmap: `docs/roadmap.md` → Phase 11 (tooling). No license-boundary or
tamper-resistance surface — plain git + npm-script orchestration.

## Goal

An **opt-in CI workflow** on `claude/**` PRs that, on `synchronize`, detects the
drizzle-kit snapshot **parent-collision** failure *specifically*, runs the
Slice-1 `db:rebase` engine (`rebaseMigrations`, no `--force`), and pushes the
regenerated migration back to the PR branch — or, on a guarded refusal, comments
for human attention instead of pushing.

## Why now

Slice 1 (#199, merged in PR #211) shipped `npm run db:rebase`
(`server/scripts/rebase-migrations.ts`): a local, staged-not-committed helper
with conflict/lossy-regen safety guards, behind injected git/fs/script seams.
Slice 2 automates that helper in CI. The Slice-1 orchestrator is already
scriptable; this slice only adds the CI-specific **decisions** + an auto-commit
+ push + comment.

## The collision, end to end (recap)

`prefix: "timestamp"` (#133) stops migration *filenames* colliding, but each
snapshot (`drizzle/meta/<prefix>_snapshot.json`) has a `prevId` parent pointer.
Two branches off the same snapshot generate migrations whose snapshots claim the
**same parent**; after a contributor merges `main` in and resolves the source
conflicts, the `migrations` job (`.github/workflows/integration.yml`,
`drizzle-kit migrate` + `check`) fails with
`… pointing to a parent snapshot: … which is a collision`. `db:rebase` fixes it
by dropping the branch-only migration + snapshot, trimming `_journal.json`, and
regenerating off the merged base.

## Design — split of responsibility

Keep every **decision** in testable TypeScript; keep the YAML thin.

### New module: `server/scripts/ci-autofix-migrations.ts`

**Reuses** the Slice-1 engine by driving its CLI (`npm run db:rebase`) as a
**subprocess**, not an in-process import. Rationale: `node
--experimental-strip-types` cannot resolve a relative `.js` specifier to its
`.ts` sibling (and `tsc` NodeNext refuses a `.ts` specifier without
`allowImportingTsExtensions`, a repo-wide convention change). Keeping the script
self-contained — exactly how `rebase-migrations.ts` is structured — sidesteps
that and inherits every Slice-1 safety guard without re-wiring it. The contract
relied on is the Slice-1 CLI's: exit ≠ 0 ⇒ refused (reason on stderr); exit 0 +
regenerated migration **staged** ⇒ done; exit 0 + nothing staged ⇒ noop.

Adds:

- `isParentCollisionFailure(output: string): boolean` — pure matcher for the
  drizzle-kit error. Robust to line-wrapping: requires both
  `"pointing to a parent"` and `"which is a collision"` (case-insensitive).
  Source of the phrasing: the `rebase-migrations.ts` module docstring and
  `docs/testing.md`.
- `headHasSkipMarker(commitMessage, marker): boolean` — loop guard; true when
  HEAD is the bot's own regen commit (carries the `[skip-regen]` marker).
- `rebaseRefusalReason(output): string` — pull the human reason out of a refused
  `db:rebase` run (`db:rebase refused: <reason>` on stderr).
- `successCommentBody` / `refusalCommentBody` — pure PR-comment bodies.
- `CiAutofixDeps` seams: `git(args)`, `checkMigrations() → {ok, output}` (runs
  `db:check`), `runRebase() → {ok, output}` (runs `db:rebase`), `comment(body)`,
  `log`. commit/push reuse `git(args)`.
- `autofixMigrations(deps, options): CiAutofixResult` orchestrator:
  1. **Loop guard** — read HEAD message via `git log -1 --pretty=%B`; skip if it
     carries the marker.
  2. `checkMigrations()`; green → `noop`.
  3. failed but **not** a parent-collision → `noop` (left to normal CI).
  4. collision → `runRebase()`:
     - exit ≠ 0 → `comment(<reason>)` → `commented` (honours the Slice-1 guard).
     - exit 0 + nothing staged under `drizzle/` → `noop`.
     - exit 0 + staged → `git commit` (`[skip-regen]` in message) +
       `git push origin HEAD:refs/heads/<branch>` + success comment → `pushed`.
- `nodeDeps(cwd, prNumber)` builds the real seams (`git`/`db:check`/`db:rebase`
  via `execFileSync`, capturing output without throwing; `comment` via `gh pr
  comment`). `main()` reads env (`GITHUB_HEAD_REF`, `PR_NUMBER`,
  `AUTOFIX_BASE_REF`), guarded by the `import.meta.url` direct-run check.

### New workflow: `.github/workflows/migration-autofix.yml`

- Trigger: `pull_request` types `[synchronize, opened, reopened]`.
- Job `if`: `startsWith(github.head_ref, 'claude/')` **and** same-repo
  (`head.repo.full_name == github.repository`) — skip forks (GITHUB_TOKEN can't
  push to forks).
- `permissions: { contents: write, pull-requests: write }`.
- `concurrency` keyed on the PR ref, `cancel-in-progress: true`.
- Steps: checkout PR head (`fetch-depth: 0`, default token) → `git fetch origin
  main` → configure `github-actions[bot]` identity → `npm ci` → run
  `npm run db:autofix-ci` with `GH_TOKEN`, `GITHUB_HEAD_REF`, and the PR number
  in env.

## Known trade-off (documented, not silently worked around)

Pushes made with the default `GITHUB_TOKEN` do **not** re-trigger workflows, so
the `migrations` check won't auto re-run after the fix; the success comment
tells the human to re-run CI (or it re-runs on their next push). Adopting a
write-scoped GitHub App / PAT to force the re-run is a **deliberate follow-up**
(don't silently add a repo secret) — filed/linked from the PR.

## Tests — `server/tests/scripts/ci-autofix-migrations.test.ts`

Vitest, in-memory fakes (extend the Slice-1 `FakeEnv` pattern with
`checkMigrations` + `comment` recorders). Cover:

- `isParentCollisionFailure`: matches the real wrapped error; rejects unrelated
  drizzle errors / empty output.
- `headHasSkipMarker`: matches the marker, ignores ordinary messages.
- Orchestrator branches:
  - skip marker on HEAD → `skipped`, no check run.
  - check green → `noop`, no rebase.
  - check red, non-collision → `noop`, no rebase, no push.
  - collision + rebase `done` → committed (`[skip-regen]` in message), pushed to
    `HEAD:refs/heads/<branch>`, success comment → `pushed`.
  - collision + rebase `refused` (hand-edit/multi) → comment posted, **no push**
    → `commented`.
  - collision + rebase `noop` → `noop`.

## Docs

Extend `docs/testing.md` → the `db:rebase` section: add a short "Slice 2 — CI
auto-fix" paragraph describing the workflow, the narrow trigger, the loop guard,
and the GITHUB_TOKEN re-trigger caveat. Keep the existing Slice-1 wording.

## Phases / commits

1. Module + npm script + unit tests (the testable core). Push → opens draft PR.
2. Workflow YAML + docs note. Push → updates PR. Then quality gate + ready.

## Out of scope (deferred)

- Forcing the post-fix CI re-run via a privileged token/app (follow-up).
- Auto-fixing non-`claude/**` branches (human branches stay manual).
- Any failure mode other than the parent-collision (left to normal CI).
