# Plan — #56: handle a user changing timezone mid-window

Roadmap: backlog edge case split from #17 / ADR 0001. Phase 2 data
foundation (#48) and the timezone decision (#17 → ADR 0001) are merged.

## Decision (to record in a follow-up ADR)

ADR 0001 settled "UTC everywhere; effective TZ = `User.tz ?? PCT_DEFAULT_TZ`
defines budget windows" and **deferred** the mid-window TZ-change case to
#56. This work resolves that deferral by choosing the lowest-risk option the
issue lists, which is also what `architecture.md` already states informally
("changing tz takes effect from the next window boundary"):

> **Pin the in-flight window to the timezone in effect when it opened.** A
> TZ change applies only from the next window boundary; the currently-open
> window keeps the boundaries it had, so a budget boundary never shifts
> under the user mid-window. No proration, no double-counting.

Recorded in a new **ADR 0003** (0001 stays frozen as Accepted; its
"Explicitly deferred" note is updated to point at 0003). `architecture.md`
"Timezones and budget rollover" updated from "deliberately out of scope" to
the resolved rule.

## Implementation

A new **pure** module `server/src/policy/budget-window.ts` (no DB / API /
transport / GPL surface), using Node 22's built-in `Intl` (no new
dependency — ADR 0001 already commits to `Intl.supportedValuesOf`):

- `isValidTimeZone(tz)` / `assertTimeZone(tz)` — IANA validation.
- `resolveEffectiveTz(userTz, defaultTz)` — `userTz ?? defaultTz`.
- `windowContaining(window, instant, tz): BudgetWindowBounds` — the
  half-open `[start, end)` UTC window of the given kind (`daily` / `weekly`
  (Mon-start, ISO 8601) / `monthly`) whose boundaries are local midnight in
  `tz`. DST-correct via a two-pass wall-clock→UTC offset reconciliation.
- `effectiveWindow(window, now, effectiveTz, change?)` — applies the pin
  rule: while `now` is in the window that was open at `change.at` (computed
  in `change.previousTz`), return that pinned window; otherwise the window
  in `effectiveTz`.

Also wire the ADR-mandated `PCT_DEFAULT_TZ` server setting into `config.ts`
(IANA-validated at startup, defaults to `UTC`) + `.env.example`, since it is
the value the helper resolves against and no other open issue owns it.

Re-export the public helper surface from `server/src/policy/index.ts`.

## Tests (`server/tests/policy/budget-window.test.ts`)

- `windowContaining` for daily/weekly/monthly, including a DST spring-forward
  (23h) and fall-back (25h) day in `America/New_York`.
- Week starts Monday; month starts on the 1st.
- `effectiveWindow` pin rule: a westward move (would **lengthen** the day)
  and an eastward move (would **shorten** it) both leave the in-flight
  window's `[start, end)` unchanged until the boundary, then switch to the
  new TZ for the next window.
- `resolveEffectiveTz`, `isValidTimeZone`/`assertTimeZone` happy + error
  paths.
- `config.test.ts`: `PCT_DEFAULT_TZ` default + round-trip + invalid-zone
  rejection.

## Phases

1. ADR 0003 + doc updates + plan (this file).
2. Helper module + config wiring + re-exports.
3. Tests; full quality gate; push (opens draft PR).
