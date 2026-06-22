# Issue #140 — Recurring day-of-week time-windows (resolver→timekpra bridge)

Roadmap: `docs/roadmap.md` → Phase 4.

## ⚠️ Concurrency note (re-scope)

This branch originally implemented the full #140 enforcement mapping. While it
was in review, **PR #188 merged an independent implementation of #140** to main
(`transport/timekpr/allowed-hours.ts`: `allowedWindowsToAllowedHours`,
`buildWeeklyAllowedHoursCommands`, `TimeWindow`, `WeeklyAllowedWindows`, plus
`TimekprClient.setWeeklyAllowedHours`) and **closed #140**. The two
implementations collided add/add on the same files.

Resolution: the merge took **main's** now-canonical mapping for the duplicated
files, and this branch is re-scoped to the **one piece main left to its
caller** — the resolver→weekly bridge.

## What this branch now contributes

`server/src/policy/weekly-windows.ts` — `resolveWeeklyAllowedWindows({schedules,
tz, reference})`. main's `WeeklyAllowedWindows` is documented as "the shape a
caller assembles by resolving `effectivePolicy` once per weekday", and on main
`setWeeklyAllowedHours` / `buildWeeklyAllowedHoursCommands` have **no callers** —
nothing builds that shape. This bridge does: it runs the effective-policy
resolver (#143) over the seven local days of a reference week and keys the
per-day `allowedWindows` by ISO weekday, typed as main's `WeeklyAllowedWindows`
so it feeds `client.setWeeklyAllowedHours(...)` / `buildWeeklyAllowedHoursCommands`
directly.

Recurring layer only (no budgets/grants/date-overrides — those adjust the daily
limit, not the static weekly allowed-hours grid; #142 is a later layer). Pure
TypeScript; week-anchoring is calendar arithmetic, DST enters only inside the
resolver's TZ conversion (DST-correct, covered by a spring-forward test).

## Tests

`tests/policy/weekly-windows.test.ts`: per-weekday keying, baseline-allow,
Mon–Fri intra-day projection, deny-everything, week anchoring, spring-forward
DST week, and an end-to-end assertion feeding main's
`buildWeeklyAllowedHoursCommands`.

## Out of scope (tracked)

- Wiring the bridge into the live CRUD→SSH push (replace the Phase-2 stub) →
  **#201** — this bridge is the resolver-side input that work consumes.
- Drag-to-order authoring editor → #63; e2guardian window swaps → Phase 6 (#90).
