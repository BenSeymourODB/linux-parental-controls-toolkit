# ADR 0012 — Weekday-varying budgets: nullable recurrence mask, within-slot resolution

- **Status:** Accepted (2026-08-07)
- **Issue:** [#141](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/141)
  (extends the effective-policy resolver [#143](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/143);
  builds on the column-reservation decision ADR 0005 / [#146](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/146);
  composes with group budgets ADR 0008 / [#134](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/134))
- **Phase:** 13

## Context

Today every `Budget` is **weekday-uniform**: `budgets` (and `group_budgets`)
carry `scope` / `target_id` / `window` / `seconds_allowed` and nothing that
varies the allowance by day of week. The effective-policy resolver
(`policy/resolve.ts`, #143) already computes the resolved day's ISO weekday but
budget resolution ignores it, and the `timekpra` push
(`transport/policy-push/resolve.ts`, #201) resolves the daily overall allowance
once and **replicates that single value across all seven** `--settimelimits`
days.

The missing capability is the common "weekday vs. weekend" shape — e.g. *2h on
school days, 4h on weekends*, or *no per-app YouTube limit on weekends*. ADR
0005 / #146 established a **7-bit ISO-weekday `recurrence_days` mask** (bit 0 =
Monday … bit 6 = Sunday; `NULL` = every day) for time-varying **schedule** and
**exception** rules; #141 brings the same grammar to budgets.

Two calls had to be settled:

1. **Representation** — how a weekday-varying allowance is stored.
2. **Resolution & precedence** — how weekday-specific and uniform budgets
   combine, and how that composes with the group-budget precedence ADR 0008
   already fixed.

## Decision

### 1. Nullable `recurrence_days` mask on `budgets` and `group_budgets`

Reuse the ADR 0005 grammar: a nullable `recurrence_days INTEGER` column (the
same 7-bit ISO-weekday mask, `1..127`) on both `budgets` and `group_budgets`.
`NULL` is the degenerate **uniform** budget — active every day, identical to a
pre-#141 row, so the reservation is behaviour-preserving and needs no data
backfill.

The mask is constrained to **`daily`-window** budgets by a `CHECK`
(`recurrence_days IS NULL OR window = 'daily'`): a rolling *weekly* or *monthly*
cap is a period total, not a per-day figure, so weekday-varying it is
meaningless. This mirrors the existing schedule mask CHECK
(`recurrence_days BETWEEN 1 AND 127`) and reuses the same
`WEEKDAY_MASK_MIN`/`WEEKDAY_MASK_MAX` bounds.

A **separate weekday-budget table** was rejected for the same reason ADR 0008
rejected a separate override table: the change is a single nullable column, not
a new shape, and both tables already flow through one structural `BudgetInput`
at resolution.

### 2. Weekday is a **within-slot** dimension; ADR 0008 slot precedence is unchanged

Budget resolution stays a two-layer composition, and #141 adds a layer **below**
ADR 0008, not across it:

- **Source precedence (ADR 0008) is unchanged and weekday-agnostic.**
  `policy/group-resolution.ts` → `gatherUserBudgets` still resolves own-vs-group
  **full-replace per `(scope, window, target)` slot**: if the user defines any
  budget for a slot, the user owns that slot; otherwise the lowest-id group that
  defines it supplies it. The slot key does **not** include the weekday mask, so
  a user's weekday budget and the group's budget for the same slot never
  co-exist in the resolved list — exactly as today.

- **Weekday selection happens inside the winning source's rows.**
  `policy/resolve.ts` → `selectBudgetsForWeekday(budgets, weekday)` runs per slot
  on the resolved day *D*: rows whose mask covers *D*'s ISO weekday
  (weekday-specific) **win over** uniform (`NULL`-mask) rows and shadow them for
  that day; rows whose mask is set but does not cover *D* are dropped. The
  surviving rows for the slot are then summed by the resolver's existing
  same-slot summing (so "two overall/daily rows" still add up, unchanged for
  uniform budgets). If a slot has weekday-specific rows but **none covers *D*
  and there is no uniform fallback**, the slot yields no daily limit that day.

This ordering is deliberate and is the only choice consistent with ADR 0008: a
per-weekday cross-source model (a user's Saturday override falling back to the
group's Monday budget) would mean a slot is sourced from **two** places on
different days, directly contradicting ADR 0008's "a slot is sourced from
exactly one place." Weekday-below-source keeps one source per slot and layers
the day dimension underneath it.

**Consequence (documented):** because the user owns a whole slot once they
define any budget for it, a user who sets *only* a weekend override for a slot
gets **no daily limit on weekdays** for that slot (the group's weekday budget,
if any, is replaced along with the rest of the slot). The two supported ways to
express "limited some days, different other days" are therefore: author the full
weekday coverage on **one** source (e.g. a weekday-masked row *and* a
weekend-masked row, or a weekday-masked row *and* a uniform fallback), or leave
the slot entirely to the group. This is the same "own fully replaces group per
slot" contract ADR 0008 already established, now observed at day granularity.

### 3. The push resolves each weekday independently

`resolvePolicyPush` resolves the overall daily allowance **per ISO weekday**
(`selectBudgetsForWeekday` for each of Monday…Sunday) rather than replicating
one value. Because Timekpr-nExT's `--settimelimits` requires a value per day, a
weekday with **no** daily overall budget is pushed as the **whole-day
allowance** (`86400s`) — the same "maximal allowance = unrestricted" expression
`unrestrictedPolicyPush` (#253) already uses — and `perWeekdaySeconds` is `null`
(no daily limit pushed at all) only when **every** weekday resolves to no limit.
The save-and-push preview diff already emits per-weekday rows when the days
differ, so a weekday-varying budget now renders honestly there.

Rolling **weekly** / **monthly** overall caps are untouched: they are period
totals, the mask is disallowed on them, and they continue to sum across the
matching `overall` rows.

## Consequences

- Weekday-varying allowances are authored by attaching a `recurrence_days` mask
  to `daily` `budgets` / `group_budgets` rows via the existing budget CRUD; no
  new endpoint or push-command shape.
- The single effective-policy resolver stays the one place weekday resolution
  lives, so enforcement (the `timekpra` push and the per-activity force-close
  sweep), the burndown/preview surfaces, and `/api/.../effective` all agree —
  the same single-composition-point invariant #362 restored for the group layer.
- The **grant overlay** is unchanged: grants remain additive on top of the
  weekday-resolved baseline, applied per user downstream (#117).
- The **authoring UI** (weekday pickers in the budget / group-budget editors) is
  a frontend follow-up in the #343 / group-editor line, out of scope for this
  backend slice.

## Alternatives not chosen

- **Per-weekday cross-source precedence** (own-specific > own-uniform >
  group-specific > group-uniform, resolved independently per day). Rejected: it
  sources a slot from two places on different days, contradicting ADR 0008, and
  adds materially more resolution complexity for an edge case (partial-weekday
  override of an inherited slot) the "author full coverage on one source"
  workaround already covers.
- **Separate `weekday_budgets` table.** Rejected: the change is one nullable
  column mirroring the reserved schedule/exception masks, not a new shape.
- **Weekday-varying weekly/monthly caps.** Rejected as meaningless — a rolling
  period total is not a per-day figure; the mask is CHECK-constrained to `daily`.
