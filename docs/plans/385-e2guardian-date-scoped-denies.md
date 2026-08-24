# Issue #385 — e2guardian: date-scoped (calendar-range) domain denies

Roadmap: `docs/roadmap.md` → Phase 13. Explicit deferral from #216
(recurring `#time:` windows). Depends on the date-scoped resolver work
**#142** (merged, PR #398): `resolve.ts` already carries the date gate
(`effective_from ≤ T < effective_to`).

## Problem

`buildE2guardianPlan` (`server/src/transport/ansible/e2guardian.ts`) renders
two of the three `deny` shapes and deliberately skips the third:

- **always-on** denies (#90) → static per-UID banned-site list (`bannedSites`).
- **recurring** weekday/time-of-day windows (#216) → an e2guardian
  `#time:`-tagged `.Include` the daemon evaluates itself (`windows`).
- **date-scoped** denies (`effective_from`/`effective_to` set) → currently
  **excluded** by both `isAlwaysOn` and `isRecurringWindow`, with a unit test
  asserting the skip.

e2guardian's `#time:` grammar expresses weekday + time-of-day only, **not** a
calendar date range, so "no social media until 2026-09-01" or a "blocked for
exam week" deny cannot be represented natively.

## Mechanism decision (per the issue)

The resolver already answers "is this rule active on calendar day D?". So we
resolve date-scoped denies **to the active-now set at plan-build time** and
rely on a periodic **re-push** to re-evaluate at the date boundary — keeping
enforcement purely *config-file + reload* (the #216 mechanism decision,
`docs/architecture.md` → "Enforcement responsibilities"). No client-side
scheduler, no e2guardian date grammar. Two sub-shapes, keyed on whether the
date-scoped rule *also* carries a recurrence window:

1. **date-scoped, non-recurring** (a plain calendar range): active continuously
   while `now ∈ [from, to)` → render into the **static banned list**, exactly
   like an always-on deny, but only while in range.
2. **date-scoped + recurring** (calendar range *and* weekday/time window):
   render the `#time:` window while `now ∈ [from, to)` and omit it outside the
   range → the daemon evaluates the intra-day/weekday part; the dashboard's
   re-push gates the calendar range.

Both gate on a **date-only** predicate (`now ∈ [from, to)`); the recurrence
part (case 2) stays daemon-side. No new schema/DTO shape is needed — case 1
reuses `bannedSites`, case 2 reuses the existing `E2guardianWindow`/`#time:`
mechanism.

## Changes

### 1. `server/src/policy/resolve.ts` — extract + export the date gate

`isRuleActiveAt` inlines the date gate (`effective_from ≤ T < effective_to`,
either bound open). Extract it as an exported pure helper so e2guardian (which
must apply the **date gate only**, not the full recurrence predicate) shares
one source of truth for the ADR-0005 semantics:

```ts
export function withinEffectiveDateRange(rule: ScheduleRule, at: Date): boolean;
```

Refactor `isRuleActiveAt` to call it — behaviour identical, existing resolver
tests unchanged.

### 2. `server/src/transport/ansible/e2guardian.ts`

- Add `at?: Date` to `BuildE2guardianPlanOptions` (default `new Date()`); thread
  it through `buildE2guardianPlan` → `resolveBannedSites` / `resolveWindowedDenies`.
- Add small local predicates `isDateScoped(rule)` and `hasRecurrence(rule)`.
- `resolveBannedSites`: include a deny when `isAlwaysOn(rule)` **or**
  (`isDateScoped(rule) && !hasRecurrence(rule) && withinEffectiveDateRange(rule, at)`).
- `resolveWindowedDenies`: include a deny when `isRecurringWindow(rule)` **or**
  (`isDateScoped(rule) && hasRecurrence(rule) && withinEffectiveDateRange(rule, at)`).
- Update the module/helper doc comments (they currently say date-scoped denies
  are deferred to #142).

### 3. `docs/architecture.md` → "Enforcement responsibilities"

Update the paragraph that defers date-scoped e2guardian denies to #142: they
are now handled by resolve-at-push-time + periodic re-push (config-file +
reload), while recurring windows stay native `#time:`.

## Tests (`server/tests/transport/ansible/e2guardian.test.ts`)

Update the two tests that assert the old skip (behaviour intentionally changes —
not a weakening), and add boundary coverage:

- date-scoped **non-recurring** deny, `at` inside range → static banned site.
- date-scoped non-recurring deny, `at` **before** `effective_from` → skipped.
- date-scoped non-recurring deny, `at` **at/after** `effective_to` → skipped.
- open-ended bounds (from-only; to-only) gate correctly.
- date-scoped **recurring** deny, in range → `#time:` window; out of range → skipped.
- a date-scoped-recurring window collapses with an identical-tag pure-recurring
  window (shared `#time:` list).
- allow/extend date-scoped rules still produce nothing.

Plus a resolver unit test for `withinEffectiveDateRange` and a guard that
`isRuleActiveAt` is unchanged.

## License boundary

None. Pure TypeScript + Drizzle reads. e2guardian stays configured by writing
config files and signalling a reload, driven by `ansible-playbook` as a
subprocess — no linkage, import, or vendoring (`CLAUDE.md` → "License
boundaries" 3 & 6).

## Deferred (tracked → follow-up issue)

The **date-boundary re-push cadence** — a periodic rebuild+push of the
e2guardian plan so a date-scoped deny switches on/off as its range opens/closes
— is out of scope. It rides on the e2guardian push boot-wiring, which is itself
already deferred (`pushE2guardianFiltering` has no production caller yet; the
`transport/reapply` scheduler re-runs playbooks but does not rebuild plans from
policy). This PR makes the pure `buildE2guardianPlan` seam correct for any
injected instant; a follow-up issue tracks wiring the periodic re-push.
