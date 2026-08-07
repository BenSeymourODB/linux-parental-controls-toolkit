# ADR 0012 — Date-specific override composition and the `extend` action

- **Status:** Accepted (2026-08-07)
- **Issue:** [#142](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/142)
- **Phase:** 13 (additive layer on the Phase 2/4 foundation)
- **Builds on:** [ADR 0004](0004-schedule-precedence.md) (first-match-wins),
  [ADR 0005](0005-recurrence-and-date-scoping.md) (recurrence + date anchoring),
  [ADR 0007 (group-targeted rules)](0007-group-targeted-policy-rules.md)

## Context

[ADR 0005](0005-recurrence-and-date-scoping.md) reserved the columns for
date-anchored policy and defined the "active at instant *T*" predicate for both
`schedules` (`effective_from`/`effective_to`) and `exceptions`
(`[effective_from ?? created_at, expires_at)`). The Phase-4 resolver (#143,
`policy/resolve.ts`) implemented that predicate **for `schedules`** — a
date-scoped recurring rule is already a candidate only while its effective
window is open.

What ADR 0005 left for #142 is the other half: **how a one-off `exception`
composes into the effective policy.** Today `effectivePolicy` consumes
`schedules`, `budgets`, and `grants` but **not** `exceptions`, so a one-off
override ("no screen time on 2026-06-30", "allow games until 9pm tonight",
"screen-free vacation week") resolves to nothing — the `exceptions` CRUD is
display-only. This ADR fixes the composition model and, per the review note on
#142, pins the `extend` action, which had been an undefined synonym for `allow`.

The `exceptions` shape carries a `target` (`overall` / `activity` / `group`), an
`action` (`allow` / `deny` / `extend`), and an active window — the same
allow/deny/extend *access* vocabulary as `schedules`, and deliberately **no**
seconds amount (an additive time amount is a `Grant`, not an exception). So an
exception is naturally a schedule-like access rule that is date-anchored rather
than recurrence-anchored.

## Decisions

### 1. Exceptions are a top-precedence, date-anchored access layer

An active exception composes into the resolver as a **schedule-like rule at the
head of the precedence order**, above every recurring `schedule` rule. It feeds
the existing first-match-wins engine (ADR 0004) rather than a second mechanism:

- **Candidacy (date gate).** An exception is a candidate on local day *D* iff
  its active window `[effective_from ?? created_at, expires_at)` overlaps *D*'s
  bounds in the user's effective timezone — the exception analogue of
  `appliesOnDay` for schedules, evaluated at day granularity (ADR 0005 anchors
  the bounds at local-day boundaries, so this is exact for every in-contract
  input).
- **Intra-day window.** An exception carries no intra-day *recurrence*, but its
  active window `[effective_from ?? created_at, expires_at)` is a precise instant
  range — an `expires_at` is an exact instant ("allow games until 9pm tonight"),
  not a day boundary. So on each day it covers, the exception applies over the
  local-minute window its instant range **intersects** with that day: an interior
  day of a multi-day override is the full `[0, 1440)`, while the first/last day is
  the partial window the instants carve out (e.g. `[0, 1260)` for an override that
  expires at 21:00 local). A day-aligned override (both bounds at local midnight)
  degenerates to whole days, exactly as the "screen-free vacation week" example
  intends.
- **Precedence.** Exceptions are placed **before** the recurring schedule rules
  in the first-match order, so an active override wins over the recurring rules
  for the target it covers — the issue's recommended "date-specific overrides
  win over recurring rules". Within the exception layer the order is
  **own-before-group** (ADR 0007 precedence) and **newest-before-older** (a more
  recently created one-off wins), giving a deterministic result when two
  overrides are active at once.

This satisfies the "coming up" intent: the `?date=` preview for a future day
already re-resolves against that day, so a future-dated exception surfaces the
moment its window opens, with no materialised rows (ADR 0005 §3).

### 2. `extend` widens the allowed window

`extend` is defined as a **pure widening union** applied after the allow/deny
first-match resolution: every active `extend` window (whether from a `schedule`
or an `exception`) is unioned onto the resolved allowed set. An `extend`
therefore **grants access past a standing `deny`** — the mechanism
[#364](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/364)
needs for Nintendo-style "adjust bedtime as well" same-day extensions.

- This is a strict superset of the prior behaviour: `extend` still permits
  access in its own window (it previously resolved as `allow` under
  first-match). The union only *adds* the case where an `extend` window was
  suppressed by a higher-precedence overlapping `deny` — now it widens past it.
- `extend` never *removes* allowed time; a `deny` that should win over an
  `extend` must be expressed as the absence of the `extend`, not the two
  competing. A self-contradictory same-day `deny` + `extend` on the same target
  resolves to allowed for the extend window (widening is applied last) — an
  authoring anomaly the editor may warn about, not a resolver concern.

### 3. Exceptions do not enter the recurring `timekpra` allowed-hours grid

The `timekpra` allowed-days/allowed-hours push is a **static weekly grid**
(`policy/weekly-windows.ts` → `transport/timekpr/allowed-hours.ts`): it resolves
`effectivePolicy` for each of the seven weekdays of a reference week and keys the
result by ISO weekday. A one-off calendar date **cannot** be expressed as a
weekly-recurring pattern, so exceptions are deliberately kept out of that grid —
exactly as `weekly-windows.ts` already documents ("date-specific overrides (#142)
… a later, separately-composed layer"). Pushing a date-specific override to a
client **when its window arrives** (and reverting after) is an offline-queue
scheduler concern
([#84](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/84)),
tracked as a follow-up. This ADR scopes exceptions to the per-day
`effectivePolicy` answer (the display, the `?date=` preview, and that future
per-day push), not the recurring grid.

Because exceptions carry no seconds amount, they do not change
`overallSeconds` or the per-activity quotas — only the allow/deny/extend
**access windows**. Per-activity quota reduction from `deny` rules is unchanged
(recurring `schedules` do not do it today either) and is out of scope here.

Consequently, **only `overall`-scoped exceptions have an observable effect
today**: like `activity`/`group`-scoped *schedule* rules, an
`activity`/`group`-scoped exception is gathered and composed but resolves to a
no-op (it neither builds an overall window nor reduces a quota) until per-target
deny enforcement lands. `gatherUserExceptions` still returns all target kinds so
the composition is ready when that enforcement does; the authoring editor should
signal that non-`overall` exceptions are not yet enforced.

## Consequences

- **Resolver.** `EffectivePolicyInput` gains an optional `exceptions` field
  (default `[]`, so the push and force-close callers that legitimately omit
  exceptions are unchanged); `effectivePolicy` composes active exceptions into
  `allowedWindows` as above, and `resolveAllowedWindows` folds in the `extend`
  union.
- **Group-aware composition.** `gatherUserExceptions` (in
  `policy/group-resolution.ts`) merges a user's own exceptions with their
  inherited group exceptions, mirroring `gatherUserScheduleRules`, so the
  effective view reflects group overrides too (no repeat of the #362
  display-vs-enforce drift within the resolver's own answer).
- **Endpoint.** `GET /api/users/:userId/effective` loads exceptions via that
  helper — the single composition point stays the resolver.
- **Deferred.** The date-arrival/offline-queue push of date-specific overrides
  (#84) and the per-activity deny-quota question are follow-ups.

## Alternatives not chosen

- **Exceptions as their own resolution pass** (separate from schedule
  precedence). Rejected: exceptions share the allow/deny/extend access
  vocabulary and target model of schedules, so modelling them as a
  top-precedence rule layer reuses ADR 0004 first-match-wins verbatim instead of
  a parallel evaluator that could drift.
- **`extend` as a first-match `allow` synonym** (status quo). Rejected: it left
  `extend` meaningless and gave #364 nothing to build on. Widening-union gives it
  a distinct, useful meaning.
- **`extend` dropped entirely** in favour of plain allow-exceptions. Rejected:
  the union semantics are cheap and unblock #364; dropping the action would be a
  breaking enum change for no gain.
