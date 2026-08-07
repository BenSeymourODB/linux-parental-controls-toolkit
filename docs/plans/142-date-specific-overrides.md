# Plan — #142 Date-specific / future-dated rules (exception composition)

Roadmap: `docs/roadmap.md` → Phase 13 (additive layer on the Phase 2/4 foundation).
Issue: [#142](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/142).

## What already exists (no work needed)

- **Schedule date-scoping** (`effective_from`/`effective_to`) is already honoured
  by the resolver: `isRuleActiveAt` and `appliesOnDay` in `policy/resolve.ts` gate
  candidacy on the effective window. "Applies only during spring break" already
  works for `schedules`.
- The **`exceptions.effective_from`** column (and `group_exceptions`) is reserved
  (#146, ADR 0005 §2): an exception is active during
  `[effective_from ?? created_at, expires_at)`. No migration is needed.

## The gap this delivers

`effectivePolicy` (`policy/resolve.ts`) consumes `schedules`, `budgets`, `grants`
— **never `exceptions`**. So a one-off / future-dated override (`allow` / `deny`
/ `extend`) resolves to nothing today; the `exceptions` CRUD is display-only.
This slice composes the exception layer into the resolver so the effective
answer (and the future-dated `?date=` preview) reflects overrides.

## Design decisions (recorded in ADR 0012)

1. **Precedence.** Active exceptions are a **date-anchored, top-precedence layer
   above recurring schedule rules** — an active override wins over the recurring
   rules for the target it covers, per the issue's recommendation. It feeds the
   existing first-match-wins engine (ADR 0004): exception rules are prepended to
   the schedule rules, so they win every segment they cover. Within the exception
   layer, own-before-group and newest-before-older.
2. **`extend` = widen.** After allow/deny first-match resolution, every active
   `extend` window (schedule **or** exception) is unioned onto the allowed set,
   so it grants access **past a standing deny**. This is the mechanism #364 needs
   for "adjust bedtime as well". Pre-existing `extend`-wins-its-own-segment
   behaviour is unchanged (the union is a no-op when the extend already wins
   first-match); the union only adds the widen-past-a-higher-precedence-deny case.
3. **Scope of the push.** Exceptions compose into the per-day `allowedWindows`
   that `effectivePolicy` produces — the display/preview answer. They do **not**
   enter the *recurring* `timekpra` allowed-hours grid (`weekly-windows.ts`): a
   one-off calendar date cannot be expressed as a weekly-recurring pattern, and
   `weekly-windows.ts` already documents that date-specific overrides are "a
   later, separately-composed layer". Pushing a date-specific override to the
   client **when its window arrives** (and reverting after) is the offline-queue
   scheduler (#84) — deferred to a tracked follow-up.

## Implementation phases

### Phase 1 — resolver + ADR (core)
- `resolve.ts`: add `ExceptionInput` + optional `exceptions` on
  `EffectivePolicyInput`; `exceptionAppliesOnDay` day-overlap gate; compose
  active `overall` exceptions as top-precedence full-day rules into
  `allowedWindows`; fold the `extend` union into `resolveAllowedWindows`.
  `exceptions` is **optional** (default `[]`) so the push/enforce callers that
  legitimately omit it are unchanged.
- `docs/adr/0012-date-specific-override-composition.md`.
- `tests/policy/resolve.test.ts`: allow/deny override, date gate
  (future `effective_from`, expired), `effective_from ?? created_at`, `extend`
  widens past a higher-precedence deny, precedence order.

### Phase 2 — group-aware gather + endpoint wiring
- `group-resolution.ts`: `gatherUserExceptions(db, userId)` — own exceptions
  (newest-first) then inherited group exceptions (groups ascending id), so the
  effective view reflects group overrides too (no #362-style drift).
- `api/policy/effective.ts`: load `gatherUserExceptions` and pass to
  `effectivePolicy`.
- `tests/policy/group-resolution.test.ts`: own+group gather, ordering.

## Deferred (tracked follow-up, linked from the PR)
- Recurring-grid / date-arrival **push** of date-specific overrides via the
  offline queue (#84) + revert — new issue.
- Per-activity **quota** reduction from `deny` rules (schedules don't do this
  today either) — out of scope, noted.
- Exception provenance in the `activeRules` wire list (a UI aid for #343).
