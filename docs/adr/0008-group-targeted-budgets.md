# ADR 0008 — Group-targeted budgets: separate table, full-replace baseline

- **Status:** Accepted (2026-06-22)
- **Issue:** [#134](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/134)
  (budget counterpart to [#182](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/182);
  follow-up to [#124](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/124))
- **Phase:** 2

> **Numbering note.** Two ADRs already carry the number 0007
> (`0007-event-stream-version-compatibility.md` and
> `0007-group-targeted-policy-rules.md`) from concurrent sessions. This budget
> decision takes the next free number, **0008**, rather than adding a third
> 0007.

## Context

[#124](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/124)
introduced the `UserGroup` entity + multi-group membership (PR #181), and
[#182](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/182)
let **schedule/exception rules** target a group with per-user override precedence
(PR #203, ADR 0007). #134 is the **budget counterpart**: a time `Budget` defined
once for a group and inherited by members as the baseline, which a member's own
`Budget` may override.

Today `budgets` is keyed by a `NOT NULL user_id`. Two design calls had to be
settled:

1. **Storage shape** — relax `budgets.user_id` to nullable + add
   `user_group_id` + an exactly-one-of CHECK (one table), **or** a separate
   `group_budgets` table (mirrors the shape, leaves the user-keyed table
   untouched).
2. **Override semantics** — how a member's own budget combines with the
   inherited group budget for the same scope/window.

## Decision

### 1. Separate `group_budgets` table

`group_budgets` mirrors `budgets` column-for-column, with `user_id` replaced by
a `user_group_id INTEGER NOT NULL` foreign key to `user_groups(id)`
`ON DELETE CASCADE`, the same polymorphic `scope`/`target_id`, `window`, and
`seconds_allowed`, and the same scope / window / non-negativity / target-coherence
CHECKs. Indexed `(user_group_id, scope, window)`.

This is the same choice ADR 0007 made for group schedules/exceptions, for the
same reasons:

- **Non-breaking.** The user-keyed `budgets` table, its `BudgetRow` type, the
  `BudgetResponse` wire contract, and the effective-policy resolver are all
  untouched. Option A would make `user_id` nullable on the wire — a breaking
  change rippling through every budget consumer — and force a SQLite
  table-recreate of the hot `budgets` table for marginal storage savings.
- **No logic duplication.** The column "duplication" is shape only. The
  resolver's `BudgetInput` is a structural, owner-agnostic interface, so a
  `group_budgets` row and a `budgets` row both satisfy it and flow through the
  one effective-budget computation. The two tables converge at resolution, not
  in storage.
- **Isolated fan-out.** A group-budget mutation must push to every member's
  clients; dedicated `/api/user-groups/:groupId/budgets` routes contain that
  fan-out instead of branching the user-budget routes on a nullable column.

### 2. Full-replace override, per `(scope, window, target)` slot

A member's effective baseline is resolved per **slot** — the
`(scope, window, target_id)` triple — by
`policy/group-resolution.ts` → `gatherUserBudgets(db, userId)`:

```
baseline(user, slot) =
    the user's own budget(s) for that slot if any,
    else the inherited group budget for that slot.
```

- A user-level budget for a slot **fully replaces** the inherited group budget
  for that slot — it is never summed with it. This is the issue's recommended
  option and the only one consistent with the model: a `Budget` is a single
  baseline *figure*, and the project's additive layer is **grants**
  (`per-day budget = policy + Σ active grants`, architecture → "Policy model").
  Summing a user override onto a group baseline would make "Alice gets 3h
  instead of the group's 2h" mean *5h*, which is not what an override means.
- The slot key includes `target_id`, so overriding the `activity:steam` budget
  does not shadow the inherited `overall` budget, and vice-versa.
- **Multi-group tiebreak: lowest group id wins.** When a member belongs to
  several groups that each define the same slot, the lowest-id group supplies
  it — mirroring the schedule resolver's deterministic "groups ascending by id"
  ordering (ADR 0007). A slot is sourced from exactly one place: the user, else
  the lowest-id group that defines it.
- **Within one source, the resolver's existing same-slot summing is
  preserved.** `gatherUserBudgets` emits all of the user's own budgets (and,
  for an inherited slot, all of the winning group's budgets for it); only
  *cross-source* slots are deduped. So a user with two `overall daily` rows
  still sums to their total exactly as before this change — no behaviour change
  for users in no group.

Each returned budget is tagged with its `source` (`{ kind: "user" }` |
`{ kind: "group"; groupId }`) for the future inherited-vs-local editor (#124,
UI deferred behind #53/#63), exactly as `gatherUserScheduleRules` tags rules.

`GET /api/users/:userId/effective` (#143) loads budgets via `gatherUserBudgets`,
so group-inherited baselines take effect in the single resolver every surface
reads.

## Scope of inheriting budgets

All three budget scopes — `overall`, `activity`, `group` (activity-group) — can
be group-defined; none is special-cased. The group budget reuses the same
polymorphic `scope`/`target_id` as `budgets`, and the slot key already
distinguishes targets, so per-activity and per-activity-group baselines inherit
and override the same way `overall` does.

## Consequences

- Group-level budgets are authored via `/api/user-groups/:groupId/budgets`
  (collection) + `/api/group-budgets/:id` (item) and inherited by every member,
  with the member's own budget taking precedence per slot.
- A group-budget mutation fans the push stub out to every member's linked
  clients, reusing the existing user-scoped `budget.created` / `budget.updated`
  / `budget.deleted` reasons (no new push command shape), via the same
  `groupMemberPushCommands` helper #182 introduced.
- The **grant overlay** is unchanged and stays per-user: the grant-recompute
  pipeline (#117, Phase 10) resolves a member's baseline through
  `gatherUserBudgets` (group or override) and then adds *that member's* grants,
  writing the result only to that member's client(s). This ADR provides the
  baseline resolution that recompute reads; it does not change the grant model.
- The inherited-vs-local **editor UI** stays in #124, blocked on the admin shell
  (#53/#63).

## Alternatives not chosen

- **Nullable `budgets.user_id` + `user_group_id` + exactly-one-of CHECK.**
  Rejected for the breaking wire change, the ripple through every budget
  consumer, and the table-recreate of the hot `budgets` table — the same
  trade-off ADR 0007 rejected for schedules.
- **Additive / min / max combination of user + group budgets.** Rejected: a
  budget is a single baseline figure, and the additive layer is grants. An
  override should *replace* the baseline, not stack on it.
