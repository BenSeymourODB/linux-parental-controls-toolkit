# Plan — #403: Cadence picker surfaces inherited group budgets

Roadmap: `docs/roadmap.md` → Phase 8b. Follow-up to #388 (own-budget cadence
picker); composes with #363 (resolved / group budgets, `listResolvedBudgets`).

## Problem

`NotificationsView`'s per-budget warning-cadence picker (`/admin/notifications`,
#388) sources its options from the selected user's **own** budgets
(`listBudgets(userId)`). It does **not** offer a cadence-override target for a
budget the user only **inherits** via a `UserGroup` (a `GroupBudget`, surfaced
by `listResolvedBudgets(userId)` with `source.kind === "group"`) — unless the
user also happens to have an own budget for that same `(scope, target)`.

A stored override for such an inherited-only budget already round-trips (its
key is folded in as a stale-key option), so this is a **discoverability** gap,
not data loss: you can't *add* a cadence override for an inherited group budget
from the picker today.

## Approach (frontend-only)

Extend the picker's option source to include inherited resolved budgets,
keeping the existing `(scope, target)` collapse and own-wins de-duplication.

1. **Load resolved budgets alongside own budgets.** In `loadBudgets(userId)`
   also call `listResolvedBudgets(userId)` (best-effort, same failure posture as
   the own-budget load — a failure degrades the picker to Overall + stored keys,
   never blocks editing). Store in new `resolvedBudgets` state; reset it on
   user de-select exactly like `budgets`.

2. **Fold inherited keys into `budgetOptions`.** Compute the own-budget key set
   as today. Then walk `resolvedBudgets`, and for each entry with
   `source.kind === "group"` and a non-null `targetId`, derive the same cadence
   key (`activity:<id>` / `group:<id>`) and collect it into an `inheritedKeys`
   set. (Inherited *overall* needs no handling — `overall` is always present and
   never marked.)

3. **Own budgets win.** A key that is both an own budget and inherited is *not*
   marked — only purely-inherited keys (`inheritedKeys \ ownKeys`) get the
   `(inherited)` suffix, matching #363/#343's own-vs-inherited presentation and
   the issue's "unless the user also has an own budget" wording.

4. **Mark inherited-only options.** Append ` (inherited)` to the label of a
   purely-inherited option in `budgetOptions`; `labelForKey` stays the shared
   name resolver. Stored-key folding and ordering (overall → activities →
   groups, then by label) are unchanged.

No storage-grammar change: the stored key is still `overall|activity:<id>|
group:<id>` — an inherited group budget is keyed identically to an own one, so
save/hydrate is untouched. No API/DTO change: `listResolvedBudgets` and
`ResolvedBudgetResponse` already exist (#363).

## Tests (frontend vitest, `tests/components/notifications-view.test.ts`)

Extend the existing `$lib/api/budgets` mock to also expose
`listResolvedBudgets` (defaulting to `[]` so every existing case is unaffected),
then add:

- An inherited-only group budget (`source.kind: "group"`) surfaces as a
  pickable `group:<id>` option labelled `Group — <name> (inherited)`, and an
  override picked from it keys/saves as `group:<id>`.
- An inherited budget the user *also* owns is offered **once**, **without** the
  `(inherited)` suffix (own wins).
- A `listResolvedBudgets` failure degrades gracefully (Overall still offered;
  editing still works), mirroring the existing own-budget-failure test.

## Out of scope (unchanged from #403)

- The combined per-user editor / effective-schedule view (#343).
- Any change to how inherited budgets are resolved server-side (#363 owns that).

## License boundary

None touched — frontend-only TypeScript/Svelte over the existing JSON API.
