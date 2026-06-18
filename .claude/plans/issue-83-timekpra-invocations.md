# Plan — #83 `timekpra` invocations (limits, allowed hours, PlayTime)

Roadmap: `docs/roadmap.md` → Phase 4 ("`timekpra` invocations for: set
daily/weekly/monthly limits, set allowed hours, set PlayTime configuration").
Module: `server/src/transport/timekpr/`.

## Goal

A typed wrapper over the Timekpr-nExT **`timekpra` admin CLI**, invoked as a
subprocess over the merged Phase-4 SSH facade (`transport/ssh`, #82). Translates
transport-level inputs into `timekpra` argv vectors, runs them via
`execChecked` / `execAndParse`, and confirms application by zod-parsing
`timekpra --userinfo` stdout. This is the structural **license boundary**: the
dashboard only ever *execs* `timekpra` (GPL) as a subprocess — never links it
in-process (`CLAUDE.md` → "License boundaries" rules 1–2; `docs/licensing-analysis.md`).

## Why this is independent of the in-flight Phase-2 schema work

#146 is reshaping the `schedules`/`exceptions` tables (recurrence/date-scoping
columns). This module sits *below* the policy model: it takes transport-level
input structs (limit-seconds, an allowed-hours spec, a PlayTime spec), not the
DB rows. The policy→transport translation of recurring schedule windows (#140)
and the effective-policy resolver (#143) are explicitly **out of scope** and
will feed this layer once #146 lands — so #83 is not coded against the schema
being changed.

## `timekpra` CLI grammar (verified against upstream docs)

ISO-8601 conventions: weekdays `1`(Mon)–`7`(Sun); hours `0`–`23`; times in
seconds. Lists are `;`-separated.

- `--setalloweddays USER 'd;d;…'` — allowed ISO weekdays.
- `--setallowedhours USER (DAY|ALL) 'H;H[mm-mm];!H;…'` — DAY is a single ISO
  weekday `1..7` or the literal `ALL`. Each hour `0..23`, optional minute
  interval `[start-end]` (0..60), optional `!` prefix = *unaccounted* (free).
- `--settimelimits USER 's;s;…'` — per-allowed-day daily limit seconds.
- `--settimelimitweek USER s` / `--settimelimitmonth USER s` — rolling limits.
- PlayTime (app-group time):
  - `--setplaytimeenabled USER (true|false)`
  - `--setplaytimelimitoverride USER (true|false)`
  - `--setplaytimeunaccountedintervalsenabled USER (true|false)`
  - `--setplaytimealloweddays USER 'd;d;…'`
  - `--setplaytimelimits USER 's;s;…'`
  - `--setplaytimeactivities USER 'mask[desc];mask;…'`
- `--userinfo USER` — prints config as `KEY: VALUE` lines (read/confirm).

Invocation: the client provisions `pct-agent ALL=(root) NOPASSWD:
/usr/bin/timekpra` (#78), so the dashboard runs `sudo timekpra …`. The binary
vector is configurable (default `["sudo", "timekpra"]`).

## Files (`server/src/transport/timekpr/`)

- `commands.ts` — **pure** argv builders + value formatters/validators
  (`formatSecondsList`, `formatDays`, `formatAllowedHours`, `formatActivities`,
  `formatBool`). Each builder returns `readonly string[]`. Throws
  `TimekprArgumentError` on invalid input (negative seconds, weekday ∉ 1..7,
  hour ∉ 0..23, minute ∉ 0..60, empty mask, …). No I/O.
- `userinfo.ts` — zod schema/transform parsing `--userinfo` stdout into a
  `TimekprUserInfo` (robust generic `KEY: VALUE` line parse → typed wrapper
  with getters; tolerant of the exact key set, which #140 pins when it wires
  the resolver). Rejects empty / non-`KEY: VALUE` output (→ `SshParseError`).
- `errors.ts` — `TimekprArgumentError` (synchronous, builder-side; distinct
  from the SSH exec taxonomy that surfaces reachability/command/parse failures).
- `client.ts` — `TimekprClient` over `SshTransport` + `SshTarget` + `username`:
  semantic methods (`setTimeLimits`, `setTimeLimitWeek`, `setTimeLimitMonth`,
  `setAllowedDays`, `setAllowedHours`, the PlayTime setters, `getUserInfo`).
  Setters use `execChecked` (non-zero exit → `SshCommandError`); `getUserInfo`
  uses `execAndParse`.
- `index.ts` — `moduleName = "transport/timekpr"` + public re-exports.

## Types (transport-level inputs)

- `IsoWeekday` (validated 1..7), `ALL_DAYS` sentinel for allowed-hours.
- `AllowedHour { hour; startMinute?; endMinute?; unaccounted? }`.
- `PlayTimeActivity { mask; description? }`.
- `TimeAdjustOperation`-free (setTimeLeft deferred — see below).

## Out of scope (deferred, tracked)

- `--settimeleft` (grant time adjustment) → belongs to the grant recompute
  pipeline (#117) / grant-unlock (#108). Note in PR.
- The policy→`timekpra` translation (which Budget/Schedule maps to which
  command) → resolver #143 + recurring-windows #140, both gated on #146.
- A live integration test against a `timekpra`-bearing container → follow-up
  (mirrors the SSH facade's deferred `ssh.int.test.ts`).

## Tests (`server/tests/transport/timekpr/`)

- `commands.test.ts` — every builder: happy argv, list formatting, the
  allowed-hours minute-bracket + `!` syntax, `ALL` day, and each validation
  failure → `TimekprArgumentError`.
- `userinfo.test.ts` — `KEY: VALUE` parse, whitespace tolerance, typed getters,
  empty/garbage stdout rejected.
- `client.test.ts` — drives a fake `SshTransport` (typed stub recording argv);
  asserts each method builds the right argv and routes through
  `execChecked`/`execAndParse`; `getUserInfo` parse path; binary override; a
  `SshCommandError` from a setter propagates unchanged.

## License-boundary note

Pure exec-over-SSH of the `timekpra` CLI; `ssh2` (MIT) already a dependency. No
GPL code linked in-process, no GPL binary added to the image. `license-guard`
unaffected.
