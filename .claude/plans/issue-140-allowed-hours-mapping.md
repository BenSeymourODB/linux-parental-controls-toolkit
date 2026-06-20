# Plan — #140 Recurring day-of-week time-windows → `timekpra` allowed-hours

Roadmap: `docs/roadmap.md` → Phase 4. ADR: `docs/adr/0005-recurrence-and-date-scoping.md`.

## What already landed (so this is the remaining slice)

- **#146** — recurrence columns on `schedules` (ISO-weekday bitmask +
  minutes-of-day intra-day window) + degenerate always-on default.
- **#143 (PR #176)** — the effective-policy resolver `policy/resolve.ts`:
  `effectivePolicy(input).allowedWindows` is an ascending, non-overlapping list
  of half-open `[start, end)` intervals in **local minutes-from-midnight**, for
  one resolved local day.
- **#83 (PR #155)** — the pure `timekpra` argv builders, incl.
  `buildSetAllowedHours(user, day, hours)` and `buildSetAllowedDays(user, days)`.

Both #143 and #83 explicitly **deferred the translation between them to #140**.

## This slice — the enforcement mapping (pure, unit-tested)

ADR 0005 §1: the recurrence grammar "maps 1:1 onto … the Timekpr allowed-hours
target", overnight spans split into two per-weekday rules, "so no information is
lost." #140 owns confirming that correspondence against the CLI grammar.

New module `server/src/transport/timekpr/allowed-hours.ts`:

1. `TimeWindow` — structural `{ start, end }` (local minutes, half-open),
   structurally compatible with the resolver's `AllowedWindow` (no
   policy→transport import; a type-level test proves the compatibility).
2. `allowedWindowsToAllowedHours(windows): AllowedHour[]` — the per-day mapper.
   For each window, for each clock hour it touches, emit a bare hour when the
   hour is fully covered, else `H[mm-mm]` for the sub-hour interval. Validates
   the windows (integers, `0 ≤ start < end ≤ 1440`, ascending non-overlapping).
   **Sub-hour fragmentation** (one clock hour containing two disjoint allowed
   intervals) cannot be represented by Timekpr's one-bracket-per-hour grammar —
   throw `TimekprArgumentError` rather than silently over- or under-permit
   (an enforcement boundary must not guess). Empty windows → `[]` (the day is
   fully denied; the weekly builder expresses that via `--setalloweddays`).
3. `WeeklyAllowedWindows = ReadonlyMap<IsoWeekday, readonly TimeWindow[]>`.
4. `buildWeeklyAllowedHoursCommands(username, weekly): string[][]` — the full
   per-week push, builder-level argv vectors (no binary prefix; the client
   prepends it):
   - allowed days = weekdays with a non-empty window list;
   - `--setalloweddays` first;
   - `--setallowedhours` per allowed day, coalesced to a single `ALL` command
     when **all seven** weekdays are allowed and share identical hours;
   - throws if no day is allowed (full lockout is a daily-limit / session-kill
     concern, not allowed-hours).

Thin transport method `TimekprClient.setWeeklyAllowedHours(weekly)` runs the
built commands sequentially over the existing SSH facade (order preserved:
allowed-days before hours). Not atomic — a failed step rejects and the
offline-queue (#84) replays the whole push; documented as such.

## Out of scope (tracked elsewhere)

- Drag-to-order authoring editor → **#63** (blocked on `/admin` shell #53).
- e2guardian per-domain time-window swaps → **Phase 6 (#90)**.
- Loading a user's schedules + resolving each weekday + driving the push from
  real DB rows → the save-and-push (#64) / per-activity enforcement (#98/#99)
  consumers, which read this translation rather than re-deriving it.

## License boundary

None touched: pure TypeScript building argv vectors for the **existing**
`timekpra` subprocess boundary. No GPL linkage, no GPL binary added, no
subprocess/REST boundary collapsed. No new dependency.

## Tests (`server/tests/transport/timekpr/allowed-hours.test.ts`)

`allowedWindowsToAllowedHours`: full day (24 bare hours), single bare hour,
sub-hour bracket at both ends, multi-hour window with partial first/last hour,
adjacent windows in different hours, empty → `[]`, fragmentation throw, invalid
windows (non-integer, out of range, descending/overlapping) throw, resolver
`AllowedWindow[]` type compatibility.
`buildWeeklyAllowedHoursCommands`: per-day commands, denied-day omission,
all-seven-identical → `ALL` coalescing, not-all-identical → per-day, all-denied
throw. `TimekprClient.setWeeklyAllowedHours`: runs the commands in order against
a fake transport, propagates `SshCommandError`, surfaces a build error as a
rejected promise.
