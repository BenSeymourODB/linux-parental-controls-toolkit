# Plan — #307: extract `buildActivityQuotas` from `effectivePolicy`

**Issue:** #307 (code-review, complexity, Effort S). `effectivePolicy`
(`server/src/policy/resolve.ts`, ~`:280-353`) resolves a user's effective
policy for a day. The per-activity/per-group quota-accumulation loop
(~`:318-343`) builds a `Map` from budgets + grants across scopes with nested
iteration — correct and tested, but dense, and #141 (weekday-varying budgets)
would make it worse.

**Unblocked:** the ticket states `resolve.ts` is in no open PR's footprint;
verified against the current backlog (PR #365 does its group work in
`group-resolution.ts`; #359/#366/#367/#368/#370/#371 touch
ansible/frontend/transport). No open PR closes #307.

## Change (pure refactor — behaviour unchanged)

Extract two module-private helpers so `effectivePolicy` reads as a clear
orchestrator (gather day → gather rules → resolve windows → resolve budgets →
return):

- `buildActivityQuotas(budgets, grants, dayBounds) -> ActivityQuota[]` — the
  per-activity/per-group daily quota map, keyed `"scope:targetId"`, folding in
  active same-scope grants, grant-only targets skipped, emitted ascending by
  `(scope, targetId)`. JSDoc documents the key format (the ticket's companion
  ask).
- `resolveOverallSeconds(budgets, grants, dayBounds) -> number | null` — the
  overall daily baseline + active overall grants, `null` when no daily overall
  budget exists. Extracted as a sibling so the orchestrator's "resolve budgets"
  step reads symmetrically.

`dayBounds` is the `{ start, end }` from `localDayBounds` — it already encodes
the effective timezone, so `tz` is **not** re-passed into the quota helpers
(passing an unused `tz` would be dead + lint-flagged). The ticket's suggested
`(…, tz)` signature is satisfied in substance by `dayBounds`; a JSDoc note
records why `tz` is redundant here.

No public export surface changes: `effectivePolicy`, `isRuleActiveAt`,
`ruleActiveAt`, and the exported types stay identical. The new helpers stay
private, mirroring the existing private helpers (`resolveAllowedWindows`,
`appliesOnDay`, …); they are fully exercised by the existing
`effectivePolicy` tests, so coverage holds.

## Validation

- `npm run format` / `lint:fix` / `typecheck` clean.
- `npm test` — existing `resolve.test.ts` (overall-budget + per-activity-quota
  suites) stays green with no test changes; coverage gate 80% held.

## License boundary

None touched — pure TypeScript over the policy model, single file.
