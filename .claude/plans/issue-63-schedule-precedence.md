# Issue #63 — Schedule/Exception precedence foundation

Roadmap: Phase 2 (policy model + admin UI). This plan covers the
**surface-agnostic precedence foundation** only; the drag-reorder editor UI
is deferred to #53 (see "Deferred" below).

## Why a slice, not the whole issue

#63 "refines #53" (the SvelteKit admin policy editors). Its UI half (drag
handle, keyboard reorder, live "in effect now" indicator, conflict
surfacing) needs the admin UI shell, which is blocked by #51 (`/api/*` CRUD)
and #52 (auth) — both open, #52 actively claimed. But the issue is explicit
that the **model decision must be settled first** so "the same precedence is
reused by the client/`/app` surfaces that display what's currently allowed."
That model half is fully unblocked and is what this PR delivers.

## Decision: first-match-wins (ADR 0004)

Rules are evaluated **top-to-bottom by ascending `ordinal`; the first rule
whose window is active wins** (`allow` / `deny` / `extend`). Rejected
alternative: most-specific-wins (overall < group < activity), which makes
ordering meaningless and surprises a parent who dragged a rule to the top.
First-match-wins matches the PR #60 mock-up and is the model parents reason
about ("the top rule beats the one below it").

`lock` (in the mock) is **not** added — the committed action set is
`allow`/`deny`/`extend` (`docs/architecture.md`, `policy/enums.ts`).
"Locked out" is overall-budget exhaustion (Phase 8c), not a schedule action.

## Phases

### Phase 1 — decision + schema + migration
- `docs/adr/0004-schedule-precedence.md` (Accepted), cross-linked from
  `docs/architecture.md`'s Schedule line.
- `schedules.ordinal` — `integer NOT NULL DEFAULT 0`; add
  `schedules_user_ordinal_idx` on `(user_id, ordinal)` (covers the
  user-only lookup as a left prefix, so the old `schedules_user_idx` is
  dropped as redundant).
- `npm run db:generate` → committed `0001_*.sql` + meta. `migrations.test.ts`
  must stay green (drift gate).

### Phase 2 — resolver module + tests
- `server/src/policy/schedule-precedence.ts` (pure, dependency-free, mirrors
  `budget-window.ts`):
  - `ScheduleRule` interface (id, ordinal, targetKind, targetId,
    cronOrWindow, action).
  - `byOrdinal(rules)` — stable ascending sort (tiebreak by id).
  - `resolveEffectiveRule(rules, isActive)` — first active rule by ordinal,
    or `undefined`. `isActive(rule) => boolean` is supplied by the caller so
    the cron/window grammar (undefined today, separate concern) stays out of
    this module.
  - `resolveEffectiveAction(rules, isActive, fallback)` — convenience.
  - `reorder(rules, orderedIds)` — reassign dense `0..n-1` ordinals to match
    a new id order; supports the editor's "persist new order" without
    needing the UI. Throws on id-set mismatch.
  - `nextOrdinal(rules)` — max+1 (0 when empty), for appends.
  - `findShadowedRules(rules)` — **conservative** shadow detector: a later
    rule is flagged unreachable only when an earlier rule has an
    equal-or-broader target (overall, or identical target_kind+target_id)
    **and** an identical `cronOrWindow` string. Broader cron-overlap
    analysis needs the (undefined) grammar → out of scope, documented.
- `server/tests/policy/schedule-precedence.test.ts` — full unit coverage.

## Deferred (tracked, not done here)
- Drag/keyboard reorder UI, live "in effect now" + conflict surfacing →
  **#53** (admin editors umbrella). Note in PR; keep #63 open until the
  editor lands.
- A defined `cron_or_window` expression grammar + the `isActive`
  implementation that parses it → its own concern; the resolver is built to
  accept it as an injected predicate. Will file/reference an issue if none
  exists.

## Validation
`npm run format:check && npm run lint && npm run typecheck && npm test`
(coverage gate 80%). License boundary: N/A — pure TS policy logic, no GPL
linkage, no transport/packaging change.
