# Issue #141 — Day-of-week-varying budgets

Roadmap: `docs/roadmap.md` → **Phase 13** (calendar-based scheduling/budgeting
extensions). Blockers #139 (ADR 0005) and #146 (column reservation) are closed;
extends the #143 resolver. Decision recorded in
[`docs/adr/0012-weekday-varying-budgets.md`](../../docs/adr/0012-weekday-varying-budgets.md).

## Goal

Let a `daily` budget vary by day of week — "2h on school days, 4h on weekends",
"no YouTube limit on weekends" — reaching both the effective-policy resolver
(display) **and** the `timekpra` push (enforcement) in the same PR, so it is not
display-only (the trap #362 fixed for group rules).

## Design (see ADR 0012)

- Weekday is a **within-slot** dimension. ADR 0008's own-vs-group full-replace
  per `(scope, window, target)` slot is **unchanged**; weekday selection runs
  inside the winning source's rows.
- A nullable 7-bit ISO-weekday `recurrence_days` mask (`NULL` = uniform),
  constrained to `daily`-window budgets.
- Per slot on day *D*: weekday-specific rows (mask covers *D*) win over uniform
  rows; non-covering specific rows drop; survivors sum (existing same-slot sum).

## Phases

### Phase 1 — schema + migration
- `server/src/policy/schema.ts`: `recurrenceDays: integer("recurrence_days")` on
  `budgets` and `group_budgets`, with two CHECKs each (mask `1..127` when set;
  `NULL` unless `window = 'daily'`), reusing `WEEKDAY_MASK_MIN/MAX`.
- `npm run db:generate` → timestamp-prefixed Drizzle migration committed under
  `server/drizzle/`.

### Phase 2 — resolver + push
- `policy/resolve.ts`: add optional `recurrenceDays` to `BudgetInput`; export
  pure `selectBudgetsForWeekday(budgets, weekday)`; apply it in `effectivePolicy`
  before overall + per-activity resolution; export
  `overallDailySecondsForWeekday` for the push.
- `transport/policy-push/resolve.ts`: resolve `perWeekdaySeconds` per ISO weekday
  (no daily budget that day → whole-day `86400`; all null → `null`).
- `policy/group-resolution.ts`: carry `recurrenceDays` through
  `mergeBudgetsWithGroups` (slot key unchanged — ADR 0008 preserved).

### Phase 3 — API DTOs + CRUD
- `api/policy/dtos.ts`: `recurrenceDays` on budget + group-budget
  create/update/response DTOs and the #363 resolved projection; `daily`-only
  refinement on create; reuse `weekdayMaskSchema`.
- `policy/repository.ts`: `recurrenceDays` on `BudgetCreate` / `BudgetUpdate` /
  `GroupBudgetCreate` / `GroupBudgetUpdate`.
- Routes: thread `recurrenceDays` from DTO → repository create/update.

### Phase 4 — tests + gate + PR
- Unit: `selectBudgetsForWeekday` precedence; `effectivePolicy` weekday-varying
  overall + per-activity; push per-weekday (mixed/all-null); `diff` per-weekday
  rows; group carry-through; DTO validation (mask range, non-daily reject);
  schema CHECK. Coverage gate 80%.
- `format` / `lint:fix` / `typecheck` / `test`; draft PR; subscribe.

## Deferred (tracked)
- Weekday-picker authoring UI in the budget / group-budget editors — frontend
  follow-up in the #343 / group-editor line (file/reference from the PR).

## License boundary

None touched — pure TypeScript over the policy model + a Drizzle migration +
zod DTOs; the `timekpra` push stays exec-over-SSH of the GPL binary as a
subprocess. No GPL linkage, no new dependency, no Docker-image change.
