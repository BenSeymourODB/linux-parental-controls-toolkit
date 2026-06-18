# ADR 0005 — Recurrence and date-scoping model

- **Status:** Accepted (2026-06-18)
- **Issue:** [#139](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/139)
- **Phase:** 2 (decision); shapes the Phase 2 schema reservation
  ([#146](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/146))
  and the Phase 4 resolver/transport
  ([#143](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/143),
  [#140](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/140))

## Context

The landed policy schema (`server/src/policy/schema.ts`, #48) expresses only
**uniform** policy:

- `budgets` — a flat `seconds_allowed` per rolling `daily|weekly|monthly`
  window; no day-of-week or date variation.
- `schedules` — a free-text `cron_or_window` column with **no defined grammar,
  parser, or resolver**. [ADR 0004](0004-schedule-precedence.md) settled how
  *overlapping* rules are ranked (first-match-wins by stored `ordinal`) but
  deliberately left "is this rule active at instant *T*?" as an injected
  predicate, calling the expression grammar "a separate, not-yet-defined
  concern." **This ADR defines that grammar.**
- `exceptions` — a one-off override active *now* until `expires_at`; there is
  no way to pre-schedule one for a future date.

Real households need time-varying policy: "no Discord on weekdays 16:00–18:00",
"weekend mornings allow YouTube", "extra hour every day during spring break
(Mar 25–Apr 2)". Phase 4 (#140 recurring day-of-week windows, #143 the
resolution engine) and Phase 13 (#141 weekday-varying budgets, #142
date-specific overrides) all build on whatever shape we pick here.

The **decision** is pulled forward into Phase 2 because it shapes the most
central tables. Reserving the right columns now (#146) is cheap; migrating
`schedules`/`exceptions` after the CRUD (#51), the editors (#53/#63), and the
Phase 4 transport already depend on the old shape is not. This ADR settles the
*model*; the column reservation (#146), the resolver (#143), and the editors
ship later against it.

## Decisions

### 1. Recurrence grammar: a purpose-built day-of-week + intra-day window

Replace the free-text `cron_or_window` with a **structured, finite**
representation of "on these weekdays, between this start and end time":

- **Days of week** — an ISO-8601 weekday set (`1` = Monday … `7` = Sunday),
  stored as a 7-bit mask (bit *i* set ⇒ active on ISO weekday *i + 1*; bit 0 =
  Monday, bit 6 = Sunday). ISO numbering is chosen over JavaScript's
  `0` = Sunday because it matches the day numbering Timekpr-nExT's allowed-hours
  configuration uses, so the Phase 4 push (#140) translates without a remapping
  table.
- **Intra-day window** — `start` and `end` as **minutes from local midnight**
  (integers, `start` in `[0, 1440)`, `end` in `(0, 1440]`, `start < end`).
  Minutes-of-day give an unambiguous, directly comparable, CHECK-constrainable
  value; the API DTO may present them as `"HH:MM"`.

A window is **anchored to a single local day**: it runs from `start` to `end`
within each listed weekday and does **not** implicitly wrap past midnight
(`end` must be strictly greater than `start`). An overnight span ("allowed
22:00 Fri → 06:00 Sat") is expressed as two rules, which is also exactly how it
lands on Timekpr-nExT's per-weekday allowed-hours, so no information is lost.

> **Rejected: cron and iCalendar RRULE.** Both describe recurring *instants*,
> not *windows* — neither carries an end-of-window natively, so "active between
> 16:00 and 18:00" needs a bolted-on duration and a custom evaluator either
> way. cron is also not human-editable in a drag-reorder UI, and RRULE's full
> generality (BYSETPOS, COUNT, interval skips) is far beyond "which weekdays,
> what hours" and would be a large parser/validator surface to carry,
> sandbox, and translate to Timekpr for no household-relevant gain. The
> purpose-built struct maps 1:1 onto both the #140 feature ("allow/deny/extend
> on chosen weekdays between start/end times") and the Timekpr allowed-hours
> target, and is trivial to render and validate.

### 2. Date anchoring: nullable effective window, stored as UTC instants

- **`schedules`** gain a nullable `effective_from` and `effective_to`. A rule is
  only a *candidate* while the evaluated instant is within
  `[effective_from, effective_to)`; either bound `NULL` means open-ended. This
  is what makes "applies only during spring break" expressible (#142).
- **`exceptions`** gain a nullable `effective_from` (so an override can be
  pre-scheduled for a future date instead of being active the moment it is
  created). The existing **`expires_at` is the effective end** for an exception
  — no separate `effective_to` column is added, to avoid two columns meaning
  the same thing and to keep the migration light. An exception is active during
  `[effective_from ?? created_at, expires_at)`.

These columns are **UTC instants** (epoch seconds), exactly like every other
timestamp in the store (`expires_at`, `granted_at`, `last_seen`, `UsageSample`
times), per [ADR 0001](0001-budget-timezone.md) → "UTC everywhere internally".
The *calendar-date* intent ("from March 25 in the user's zone") is realised at
the edge: the editor/DTO computes the UTC instant of the local-day boundary in
the user's effective timezone — the same pattern ADR 0001 prescribes for
`Grant.expires_at` ("the UTC instant of the user's local end-of-day"). The
resolver then compares instants directly.

> **Rejected: storing civil dates (`"YYYY-MM-DD"` text).** More semantically
> honest for "applies on these calendar days", but it would be the first
> local-time value persisted in a store whose entire convention (ADR 0001) is
> UTC instants, and it would not match the already-shipped `expires_at`
> column. The drift it avoids (a stored boundary instant being a little off the
> *new* local midnight after a `User.tz` change) is already governed by
> [ADR 0003](0003-mid-window-timezone-change.md), which pins an in-flight
> window to the timezone in effect when it opened; for a multi-day date range
> that drift is negligible. Storage uniformity wins.

### 3. Resolve on the fly, do not materialize

"What applies for user *U* on day *D*?" is computed **from the rules**, on
demand, by the resolution engine (#143). We do **not** materialize per-day rows.

Materialization is reserved as an *optional cache* the resolver may add later
(e.g. memoising a day's resolved windows) — never as the source of truth and
never something the CRUD layer writes. The rules remain the only authoritative
representation.

> **Rejected: materialized per-day entries.** Expanding every recurrence into
> concrete dated rows bloats the store, needs a horizon (how far ahead do we
> expand? what regenerates the tail?), and turns every rule edit into a
> re-expansion job. Rule-based resolution is compact, has no horizon, and an
> edit takes effect immediately on the next resolve. The only thing
> materialization buys — read speed — is better served by an optional cache
> keyed on `(user, date, ruleset-version)` if profiling ever shows a need.

### 4. Retention interaction (#135)

Because resolution is rule-based, **recurrence rules are not dated data** and are
never purged by retention. Data-retention enforcement
([#135](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/135))
targets only *dated* rows — `UsageSample` history, the `Grant` ledger, audit
entries, and **date-specific** policy rows whose effective window lies wholly in
the past (an `exception` past its `expires_at`, or a `schedule` past its
`effective_to`). A purely recurring schedule (no `effective_to`) has no "age"
and is out of retention's scope entirely. This is the property the roadmap's
Phase 13 note already assumed ("rule-based resolution means retention targets
only *dated* data — not the recurrence rules themselves").

### 5. Timezone: resolve in the user's effective TZ

All recurrence and date-anchor evaluation happens in the user's **effective
timezone** (`User.tz ?? PCT_DEFAULT_TZ`), per
[ADR 0001](0001-budget-timezone.md) / [ADR 0003](0003-mid-window-timezone-change.md):

- The weekday and minute-of-day of the evaluated instant are taken **in that
  zone** (so "weekdays 16:00–18:00" means 16:00–18:00 *local*, and "Friday"
  means the local Friday).
- The `effective_from`/`effective_to`/`expires_at` instants are compared
  directly (they are UTC), having been computed from local-day boundaries at
  write time.

Storage stays UTC; local time enters only at resolution, matching exactly how
budget rollover already works.

## How this composes with ADR 0004 (precedence)

[ADR 0004](0004-schedule-precedence.md) ranks a user's overlapping rules by
ascending `ordinal` (ties by `id`) and takes the first one **active** at the
evaluated instant — injecting "active?" as a predicate it left undefined. This
ADR supplies that predicate. A schedule rule is **active at instant *T*** (in the
user's effective TZ) iff:

1. **Date gate** — `effective_from` is `NULL` or `≤ T`, **and** `effective_to`
   is `NULL` or `> T` (for an exception, `effective_from ?? created_at ≤ T < expires_at`); **and**
2. **Recurrence gate** — the recurrence is the always-on degenerate (see below),
   **or** the local ISO weekday of *T* is in `recurrence_days` (when set) **and**
   the local minute-of-day of *T* is in `[start, end)` (when set).

Precedence (first-match-wins) is then applied across the rules that pass both
gates. The grammar lives in its own resolution module (Phase 4, #143), the same
way precedence lives in `policy/schedule-precedence.ts`; the two compose without
either re-implementing the other.

## Degenerate default = always-on

This is the invariant #146 reserves the columns around: **a rule with no
recurrence and no effective window behaves exactly like today's uniform rule.**

- A `schedule` with `recurrence_days`, `start`, `end`, `effective_from`, and
  `effective_to` all `NULL` is *always* active — its only behaviour is its
  `action`, ranked by `ordinal`, identical to the pre-recurrence model.
- An `exception` with `effective_from` `NULL` is active from creation until
  `expires_at`, identical to today.

So the column reservation is non-breaking: Phase 2 CRUD and the precedence
resolver work unchanged while the new columns sit ready for #140/#143 to honour.

## Reserved schema shape (implemented by #146)

This is the shape #146 reserves; exact column mechanics (e.g. JSON blob vs.
discrete columns) are #146's to finalise, but the model is fixed here. Discrete,
CHECK-constrainable columns are recommended, mirroring the existing
`targetCoherence` idiom:

```
schedules  + recurrence_days        INTEGER NULL   -- 7-bit ISO-weekday mask, 1..127; NULL = no weekday restriction
           + recurrence_start_minute INTEGER NULL  -- 0..1439 local minutes; NULL with end NULL = no intra-day restriction
           + recurrence_end_minute   INTEGER NULL  -- 1..1440 local minutes, > start
           + effective_from          INTEGER NULL  -- UTC epoch seconds, inclusive; NULL = open start
           + effective_to            INTEGER NULL  -- UTC epoch seconds, exclusive; NULL = open end
           (cron_or_window is replaced by the above; it had no grammar/consumer yet)

exceptions + effective_from          INTEGER NULL  -- UTC epoch seconds, inclusive; NULL = active from created_at
           (expires_at is retained as the effective end)
```

Coherence constraints #146 should encode:

- `recurrence_start_minute` and `recurrence_end_minute` are **both** `NULL` or
  **both** set; when set, `0 ≤ start < end ≤ 1440`.
- `recurrence_days`, when set, is in `[1, 127]` (at least one weekday).
- `effective_from ≤ effective_to` when both are set (and, for exceptions,
  `effective_from < expires_at` when `effective_from` is set).

The zod DTOs (#51/#146) validate the same invariants at the API boundary, the
single source of truth shared with the frontend and integrators.

## Consequences

- **Schema (#146)** reserves the columns above now, non-breaking, so the most
  central tables never need a later migration.
- **Resolver (#143)** implements the "active at *T*" predicate defined here and
  feeds first-match-wins precedence (ADR 0004); the burndown views, enforcement,
  and the save-and-push diff all read the one resolver.
- **Transport (#140)** translates an active `allow`/`deny`/`extend` window into
  Timekpr-nExT allowed-hours; the ISO-weekday + minutes-of-day shape maps
  directly, with no in-process linkage to any GPL component (`timekpra` is still
  driven as a subprocess — this ADR adds no new boundary crossing).
- **Editors (#53/#63)** render a finite, human-meaningful struct (weekday
  toggles + time pickers + optional date range), not a cron/RRULE string.
- **Retention (#135)** purges only dated rows; recurrence rules are out of scope.
- **Extensibility.** Day-of-week-varying budgets (#141) reuse the same
  `recurrence_days` concept on `budgets`; date-specific overrides (#142) reuse
  `effective_from`/`effective_to`. Neither needs a new table — they add
  composition layers on the reserved shape, as the roadmap intends.

## Alternatives not chosen

Recorded inline above: **cron** and **iCalendar RRULE** for the grammar (§1),
**civil-date text** for date anchoring (§2), and **materialized per-day entries**
for resolution (§3).
