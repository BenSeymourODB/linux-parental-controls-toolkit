# Plan — #134 Group-level time budgets (inherited baseline)

Roadmap: `docs/roadmap.md` → Phase 2. The **budget counterpart** to #182/PR #203
(group-targeting on Schedule/Exception). Builds on #181 (`UserGroup` +
membership + CRUD) and #182 (group rules + resolver), both merged.

## Goal (this slice)

Let a `Budget` be defined **once for a `UserGroup`** and inherited by members,
with a member's **own** `Budget` for the same scope/window **fully replacing**
the inherited group baseline. Wire the resolved per-user baseline into the
existing effective-policy engine so a member inherits the group budget unless
overridden.

```
baseline(user, scope, window) =
    the user's own Budget for (scope, window, target) if any,
    else the inherited group Budget for that slot (lowest group id wins).
effective = baseline + Σ active per-user grants     # grant overlay = #117 (Phase 10)
```

## Decisions (recorded in ADR 0008)

- **Storage: separate `group_budgets` table** (Option B), consistent with
  ADR 0007's reasoning for group schedules — additive, non-breaking, the
  user-keyed `budgets` table + its wire contract untouched. The two tables
  converge at resolution, not in storage.
- **Override semantics: full replace per slot.** A user-level budget for a
  `(scope, window, targetId)` slot fully replaces the inherited group budget for
  that slot (the issue's recommended option), matching how `Budget` is a single
  baseline figure, not an additive layer (grants are the additive layer).
- **Multi-group tiebreak: lowest group id wins.** Mirrors the schedule
  resolver's deterministic "groups ascending by id" ordering. A slot is sourced
  from exactly one place: the user, else the lowest-id group that defines it.
- **Within one source, the existing resolver sum semantics are preserved** (the
  resolver already sums multiple same-slot budgets); only *cross-source* slots
  are deduped (user beats group, earlier group beats later group).
- **Scopes that inherit:** all three (`overall`, `activity`, `group`) — the
  group budget reuses the same polymorphic `scope`/`target_id` as `budgets`, so
  no scope is special-cased.

## Deferred (tracked)

- **Grant-recompute wiring** → #117 (Phase 10). This slice provides the per-user
  baseline resolution that recompute will read; it does not change the grant
  pipeline.
- **Admin UI** (edit group budgets, inherited-vs-local) → #124, blocked on the
  `/admin` shell (#53/#63).

## Phases

### Phase 1 — Storage
- `group_budgets` table in `policy/schema.ts`: mirror `budgets` minus `user_id`,
  keyed by `user_group_id NOT NULL` FK → `user_groups(id)` `ON DELETE CASCADE`.
  Columns: scope, target_id, window, seconds_allowed. CHECKs: scope, window,
  `seconds_allowed >= 0`, target coherence. Index `(user_group_id, scope,
  window)`.
- `npm run db:generate` (additive, no recreate) + `db:check` clean.
- `tests/policy/migrations.test.ts`: add `group_budgets` to `EXPECTED_TABLES` +
  a column-shape test mirroring the `group_schedules` one.

### Phase 2 — Repository + resolution
- Repository (`policy/repository.ts`): `GroupBudgetRow`, `GroupBudgetCreate`,
  `GroupBudgetUpdate`, `listGroupBudgets`, `getGroupBudget`, `createGroupBudget`,
  `updateGroupBudget`, `deleteGroupBudget` — mirror the group-schedule fns.
- `policy/group-resolution.ts`: `gatherUserBudgets(db, userId): GatheredBudget[]`
  (`BudgetInput & { source: RuleSource }`). User's own budgets first (all of
  them, slots marked covered), then each group ascending by id contributing only
  its not-yet-covered slots.
- Wire into `api/policy/effective.ts`: replace the inline `budgets` query with
  `gatherUserBudgets`.
- Tests: `repository.test.ts` (CRUD + cascade), `group-resolution.test.ts`
  (own-wins, inherited, multi-group tiebreak, slot dedup, resolver consumption),
  `effective` route group-inheritance + own-override.

### Phase 3 — API
- DTOs (`api/policy/dtos.ts`): `createGroupBudgetSchema` (no userId),
  `updateGroupBudgetSchema`, `groupBudgetResponseSchema`, `toGroupBudgetResponse`.
- Routes (`api/policy/routes.ts`): `/user-groups/:groupId/budgets` (GET, POST) +
  flat `/group-budgets/:id` (GET, PATCH, DELETE); `groupMemberPushCommands`
  fan-out reusing `budget.created/updated/deleted` (no new push reason).
- Barrel re-exports in `api/policy/index.ts` + `api/index.ts`.
- Tests: `policy.test.ts` route round-trips, 404/400, member fan-out.

### Phase 4 — Docs
- `docs/adr/0008-group-targeted-budgets.md` recording the decisions above.
- `docs/architecture.md` → "Policy model": one sentence on group budgets.

## License boundary
N/A — pure TypeScript + zod + Drizzle. No GPL linkage, no subprocess/REST
boundary, no Docker-image change. No new dependency.
