# Plan — #361: author recurrence (day-of-week + time windows) + date scoping on schedule rules

Roadmap: `docs/roadmap.md` → Phase 4 (last mile of #140). **Frontend-only.**
The backend (DTOs, schema CHECKs, resolver, timekpra push) is already
recurrence-aware — no server/model changes.

## Problem

`SchedulesView.svelte` and `GroupSchedulesView.svelte` can only create/edit
**always-on** rules: the create form hard-codes `recurrenceDays` /
`recurrenceStartMinute` / `recurrenceEndMinute` / `effectiveFrom` /
`effectiveTo` to `null`, and inline edit exposes `action` only. "Allow Games
Mon–Fri 16:00–18:00" and "deny overall after 21:00 daily" are API-only today.

## Model recap (from `server/src/policy/recurrence.ts`)

- `recurrenceDays`: 7-bit ISO weekday mask, bit0=Mon…bit6=Sun, `[1,127]`;
  `null`/empty = every day.
- `recurrenceStartMinute` / `recurrenceEndMinute`: minutes from local midnight,
  half-open `[start,end)`, both-or-neither, `0 <= start < end <= 1440`.
- `effectiveFrom` / `effectiveTo`: ISO-8601 UTC instants (`z.string().datetime()`),
  `null` = open-ended; `effectiveFrom < effectiveTo` when both set.
- Degenerate all-null row = always-on.
- PATCH accepts all fields; cross-field invariants re-checked by storage CHECK
  → 400. Client validation mirrors the invariants so an invalid combo can't
  be submitted; server errors still surfaced via the existing `error` alert.

## Design

### 1. `src/lib/recurrence.ts` — pure helpers (unit-tested, shared, reusable by #343)

- `WEEKDAY_LABELS` / `WEEKDAY_FULL` — Mon…Sun / Monday…Sunday.
- `dayChecked(mask, i)` / `toggleDay(mask, i, checked)` — checkbox ↔ mask;
  empty selection → `null` (every day).
- `minutesToTimeInput(min)` / `timeInputToMinutes(value, isEnd)` — `HH:MM` ↔
  minutes. **End-of-day convention:** an *end* time of `00:00` maps to `1440`
  (native `<input type=time>` can't express 24:00, and end can never legitimately
  be 0 because `start < end` with `start >= 0`); `minutesToTimeInput(1440)` → `"00:00"`.
- `instantToDateInput(iso)` / `dateInputToInstant(value)` — ISO instant ↔
  `YYYY-MM-DD`, using **local** midnight so the round-trip is stable in the
  admin's browser TZ and matches the summary's `toLocaleDateString()`.
- `validateRecurrence(value)` → `string | null` — mirrors the DTO superRefine
  (both-or-neither minutes, `start < end`, `effectiveFrom < effectiveTo`).

### 2. `src/lib/components/RecurrenceFields.svelte` — reusable picker

Presentational; `$bindable` model props (`recurrenceDays`, two minutes, two
instants), `disabled`, `error` (rendered when non-null), `idPrefix`. Renders a
fieldset/legend with 7 weekday checkboxes (full-name aria-labels), start/end
`type=time` inputs, from/to `type=date` inputs, and an "empty = every day / all
day / open-ended" hint. Uses the helpers above; writes model props on input.

### 3. Wire into `SchedulesView` + `GroupSchedulesView`

- Create form: add `new*` recurrence state, mount `<RecurrenceFields>`,
  send authored values (not null), reset on success. `createDisabled` gains
  `newRecurrenceError !== null`.
- Inline edit: add `edit*` recurrence state, populate in `startEdit`, mount
  `<RecurrenceFields>` in the editing row, send action + all 5 recurrence
  fields in the PATCH (full set so the stored row matches the editor). Save
  disabled on `editRecurrenceError`.
- Keep the existing `recurrenceSummary` / `daysLabel` / `clockLabel` collapsed
  display untouched (distinct semantics: display shows `24:00`, input shows
  `00:00`). Remove the "#140 pending" hint text.

## Tests

- `tests/components/recurrence.test.ts` — helper units: mask toggle/decode,
  time round-trips incl. end `00:00`↔`1440` and start `00:00`, date round-trip
  (TZ-independent), validation for each invariant + the valid degenerate.
- `tests/components/recurrence-fields.test.ts` — component: toggling a day sets
  the mask, entering times sets minutes (end 00:00 → end-of-day), date inputs
  set instants, error prop renders.
- `tests/components/schedules-view-authoring.test.ts` — create sends authored
  recurrence; edit sends action + recurrence; invalid combo disables submit.
- `tests/components/group-schedules-view-authoring.test.ts` — same for groups.

## Acceptance criteria mapping

- "Games Mon–Fri 16:00–18:00" + "deny overall after 21:00 daily", create+edit,
  user + group → create/edit tests assert the exact payloads.
- Date-scope authoring both editors → covered.
- Validation blocks invalid combos → `validateRecurrence` + disabled-submit tests.
- Reorder / in-effect / shadow unchanged → existing reorder suites still pass.
- Quality gate green → svelte-check + frontend vitest + server gate.

## Out of scope (tracked elsewhere)

- Date-scoped/exception **resolution** semantics (#142).
- Combined Policy view composition (#343) — pickers built reusable for it.
- Timekpr sub-hour representation warnings — handled at push time.
