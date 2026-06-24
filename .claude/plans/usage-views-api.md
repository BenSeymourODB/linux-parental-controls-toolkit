# Plan — #62 Admin burndown + per-activity timeline (Phase 5)

Roadmap: `docs/roadmap.md` → Phase 5 (ActivityWatch telemetry → derived views).
Architecture: `docs/architecture.md` → "Key derived views" (per-user budget
burndown; per-activity timeline). ADR 0001/0003 (effective-TZ window rollover).

## Problem

`policy/usage.ts` (#88) already computes the rollups the two views need
(`usageByActivityInWindow`, `groupSecondsInWindow`, `activityTimeline`) and
`policy/budget-window.ts` resolves the effective-TZ window. But there is **no
`/api` surface** exposing them and **no `$lib/api/usage`** wrapper, so the
"rendering half" (#62) has nothing to consume. This slice closes that gap and
ships the two reusable components.

## Scope (this PR)

### Phase A — backend usage API (`server/src/api/usage/`)
Mirrors `GET /api/users/:userId/effective` (#143, `api/policy/effective.ts`):
thin DB seam over the pure rollups, admin-guarded, single `/api` zod contract.

- `GET /api/users/:userId/usage/burndown?window=daily|weekly|monthly`
  → `{ userId, window, tz, windowStart, windowEnd, now, budgets: [{ scope,
  targetId, allowedSeconds, consumedSeconds }] }`. One row per budget the user
  has in that window; `consumedSeconds` from the matching rollup (overall = Σ
  all samples in window; activity = `usageByActivityInWindow`; group =
  `groupSecondsInWindow`). `allowedSeconds` = the budget row's `secondsAllowed`
  (baseline; grant overlay deferred — see below).
- `GET /api/users/:userId/usage/timeline?from&to`
  → `{ userId, tz, from, to, activities: [{ id, kind, matcher }], samples:
  [{ activityId, startedAt, endedAt }] }`. Raw intervals from `activityTimeline`
  plus the distinct activities they reference, for lane labels. Defaults to the
  user's `daily` window (today) when `from`/`to` omitted.
- DTOs in `api/usage/dtos.ts`; routes in `api/usage/routes.ts`; barrel
  `api/usage/index.ts`; wired in `api/plugin.ts` after auth (needs `settings`
  for the server-default TZ). Re-export DTO types from `api/index.ts`.
- Tests: `server/tests/api/usage/routes.test.ts` — 401 guard, 404 unknown user,
  400 bad window/dates, happy paths (overall + per-activity + group consumed),
  default-window, effective-TZ. Time-bomb-safe fixtures (samples relative to
  `Date.now()`, per #254).

### Phase B — frontend burndown
- `server/frontend/src/lib/api/usage.ts` typed wrapper (`getBurndown`,
  `getTimeline`); contract re-exports in `lib/api/contract.ts`.
- `server/frontend/src/lib/components/charts/BudgetBurndown.svelte` (Svelte 5,
  hand-rolled SVG, **no new dep**): remaining-vs-budget curve derived from the
  budget total + timeline samples, ideal-pace reference line, "now" marker,
  Today/Week/Month toggle. Reads the API itself (window toggle re-fetches).
- Component test `tests/components/budget-burndown.test.ts` (mock `$lib/api/usage`).

### Phase C — frontend timeline
- `server/frontend/src/lib/components/charts/ActivityTimeline.svelte`:
  per-activity horizontal lanes across `[from,to)`.
- Component test `tests/components/activity-timeline.test.ts`.

## Deferred (tracked via a follow-up issue linked from the PR)
- **Discrete grant-bump markers** on the burndown — needs the Phase-10 Grant
  ledger / grant endpoints (#113…), not built yet. `effectivePolicy` folds
  grant *totals* into the daily budget, but per-event markers need ledger
  timestamps. Baseline budget is what's meaningful today.
- Wiring the components into a concrete `/admin` user-detail route (composes
  with #53 shell).
- Playwright/real-browser E2E (guide warns against standing one up here).

## License boundary
Plain TypeScript + zod + Drizzle over the policy model; type-only frontend
imports of the contract (erased at build). No GPL linkage, no Docker image
change.
