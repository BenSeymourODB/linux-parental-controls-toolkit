# Issue #140 — Recurring day-of-week time-windows → `timekpra` enforcement mapping

Roadmap: `docs/roadmap.md` → Phase 4 ("Recurring day-of-week time-windows on
schedules … pushed as Timekpr-nExT allowed-hours").

## What already landed (do not rebuild)

- **#146** — recurrence + date-scoping columns reserved on `schedules`
  (`recurrenceDays`, `recurrenceStartMinute`, `recurrenceEndMinute`,
  `effectiveFrom`, `effectiveTo`) + validators (`policy/recurrence.ts`).
- **#143** — the effective-policy resolver (`policy/resolve.ts`):
  `effectivePolicy({date, tz, schedules, budgets, grants})` already projects
  recurring `overall` schedule rules onto a day and returns
  `allowedWindows: AllowedWindow[]` (half-open `[start,end)` local
  minutes-from-midnight, ascending, non-overlapping; `[]` = denied all day,
  `[{0,1440}]` = unrestricted).
- **#51/#148** — schedule CRUD DTOs already accept the recurrence fields
  (`scheduleRecurrenceSchema` in create + patch).
- **#83** — `timekpra` command builders + `TimekprClient`
  (`buildSetAllowedDays`, `buildSetAllowedHours`, `client.setAllowedDays`,
  `client.setAllowedHours`) — but **no caller wires schedules to them**;
  policy mutations still run through the Phase-2 logging stub
  (`transport/stub.ts`).

## The gap this PR fills

The missing Phase-4 piece is the **enforcement mapping**: turn the resolver's
`allowedWindows` into `timekpra` allowed-days + allowed-hours invocations.
Pure, exhaustively unit-testable, no live env, no UI.

`timekpra` grammar (from `transport/timekpr/commands.ts`):
- `--setalloweddays USER 'd;…'` — which ISO weekdays the user may log in.
- `--setallowedhours USER (DAY|ALL) 'H;H[mm-mm];…'` — per hour `0..23`, with an
  optional **single** contiguous minute sub-window `[mm-mm]`, `0≤mm<mm≤60`.

## Deliverables

1. **`src/transport/timekpr/allowed-hours.ts`** (pure; depends only on
   `commands.ts` types + the `AllowedWindow` type from `policy/resolve.ts`,
   type-only):
   - `dayWindowsToAllowedHours(windows): AllowedHour[]` — map one day's
     resolved windows to `AllowedHour[]`. Whole hour → bare `{hour}`; partial
     hour → `{hour, startMinute, endMinute}` (end may be 60). Defensively
     validates the input is ascending / non-overlapping / in `[0,1440]`.
     **Throws `TimekprArgumentError`** if a single hour would need ≥2 disjoint
     sub-windows (a sub-hour deny gap inside an otherwise-allowed hour) — a
     documented granularity limit of `timekpra` allowed-hours; the only
     alternative is silently over- or under-permitting.
   - `DayAllowance = { kind: "allowed"; hours } | { kind: "denied" }` +
     `dayAllowance(windows)`.
   - `timekprWeekCommands(username, perDay: Map<IsoWeekday, AllowedWindow[]>):
     string[][]` — `--setalloweddays` for the allowed weekdays, then one
     `--setallowedhours` per group of weekdays sharing an identical hour list
     (uses the weekday-list day position to coalesce). Throws if **no** day is
     allowed (whole-week lockout is the Phase-8c lockout flow, not
     allowed-hours).
   - `applyWeeklySchedule(client: TimekprClient, perDay)` — issue the same
     calls over the existing `TimekprClient` seam (real push capability,
     fake-transport tested).

2. **`src/policy/weekly-windows.ts`** — `resolveWeeklyAllowedWindows({
   schedules, tz, reference })`: call `effectivePolicy` for the 7 local days of
   `reference`'s week and key the resulting `allowedWindows` by ISO weekday.
   The recurring weekly pattern enforcement reads; date-specific overrides
   (#142) and grants are not part of a static weekly allowed-hours schedule.

## Explicitly out of scope (tracked elsewhere)

- Replacing the CRUD→SSH **push stub** with live dispatch (resolve a user's
  clients, push per client, queue when offline) — the broader Phase-4 push
  orchestration the stub's own docstring frames as its swap-point; overlaps
  #83/#84 wiring. Filed as a follow-up.
- The **drag-to-order authoring editor** to set windows in the UI — #63
  (blocked on the `/admin` shell #53).
- **e2guardian per-domain time-window swaps** — Phase 6 (#90).

## Tests

`tests/transport/timekpr/allowed-hours.test.ts` (exhaustive): full-day, denied,
single window, partial-hour at start/end, end-at-1440, multi-window day,
split-hour throw, week-command grouping/coalescing, whole-week-lockout throw,
applier over a fake transport. `tests/policy/weekly-windows.test.ts`: per-weekday
keying, recurring window resolution, denied day → empty.
