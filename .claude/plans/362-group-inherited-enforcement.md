# Plan — #362: wire group-inherited schedules/budgets into enforcement

**Issue:** #362 (Phase 2, `bug`). Group-targeted schedules/budgets landed
end-to-end (#134/#182) *except enforcement*: the resolution helpers
`gatherUserScheduleRules` / `gatherUserBudgets` (`policy/group-resolution.ts`)
are consumed by exactly one caller — the display endpoint
`GET /api/users/:userId/effective`. Every path that actually enforces or
previews reads the user's **own** rows only, so group rules are silently
display-only.

## Root cause

Two composition points exist and have drifted:

- **Display** (`api/policy/effective.ts`) composes via the `gather*` helpers →
  includes group rules.
- **Enforcement / preview / ansible renders** read own-only rows
  (`listUserSchedules` / `listUserBudgets` / inline `db.select()`), never the
  group layer.

## Fix — one shared composition point

Make `policy/group-resolution.ts` the single entry point every surface reads,
so display, push, force-close, preview, and the ansible renders can't drift
again (the one decision the issue asks to record).

Extract merge cores that take the *own* rules explicitly, so preview can merge
a **proposed** own-rule set with the **persisted** group rules:

- `mergeScheduleRulesWithGroups(db, userId, ownRules)` — own-first, then each
  group's rules (ascending group id), re-sequenced to dense ordinals.
- `mergeBudgetsWithGroups(db, userId, ownBudgets)` — own-first full-replace per
  `(scope, window, target)` slot.
- `gatherUserScheduleRules` / `gatherUserBudgets` become thin wrappers that pass
  the user's persisted own rows to those cores (behaviour unchanged — existing
  tests stay green).

## Phase 1 — core enforcement paths (push + force-close)

1. `policy/group-resolution.ts`: extract the two merge cores; keep `gatherUser*`
   as wrappers.
2. `transport/policy-push/platform-runner.ts`: widen
   `PolicyEnforcementContext.schedules` from `readonly ScheduleRow[]` to
   `readonly ScheduleRule[]`, and `budgets` from `readonly BudgetRow[]` to
   `readonly BudgetInput[]`. The Linux runner only forwards these to
   `resolvePolicyPush` (which already takes those subsets), so this is a safe
   widening; `GatheredScheduleRule`/`GatheredBudget` satisfy the subsets.
3. `transport/policy-push/executor.ts`: read `gatherUserScheduleRules` /
   `gatherUserBudgets` instead of `listUserSchedules` / `listUserBudgets`.
4. `enforcement/evaluate.ts`: replace the inline own-only schedule/budget
   `db.select()`s with the `gather*` helpers (grants stay own-only — they are a
   per-user additive layer).
5. Tests: a group-only schedule/budget shows up in a push's `timekpra` args and
   drives a force-close decision; a user-level rule overrides an inherited one.

## Phase 2 — preview + ansible renders

6. `api/policy/preview-routes.ts`: `before` = `gatherUser*` (mirrors the push);
   `after` = `mergeScheduleRulesWithGroups(proposedOwn)` /
   `mergeBudgetsWithGroups(proposedOwn)` so an edit to the user's own rules is
   diffed against the same persisted group layer the push will re-merge. Update
   the doc comment (the old "deliberately does not use gather" note inverts).
7. `transport/ansible/e2guardian.ts`: `resolveBannedSites` reads `gatherUser*`;
   `isAlwaysOn` typed to the `ScheduleRule` subset so gathered rules fit.
8. `transport/ansible/apparmor.ts`: `listUserAlwaysOnDenies` reads `gatherUser*`;
   `isAlwaysOn` / `executablesForDeny` typed to `ScheduleRule`.
9. Tests: an always-on group deny appears in the e2guardian banned-sites plan
   and the AppArmor denials; the preview diff includes a group rule.

## Out of scope (per issue)

- Exceptions in resolution (user or group) — `resolve.ts` consumes no
  exceptions yet (#142).
- Weekday-varying budgets (#141); group-editor UI (#343/#363).
- Recurring/date-scoped group denies in e2guardian/AppArmor (#216/#243) — only
  **always-on** group denies participate in the static renders, matching the
  own-rule behaviour those renders already have.

## License boundary

None touched — plain TypeScript over the policy model + Drizzle reads. Ansible
and `timekpra` stay subprocesses; nothing linked/vendored; no GPL binary added
to the image.
