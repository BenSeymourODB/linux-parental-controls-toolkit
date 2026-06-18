# Issue #143 — Effective-policy resolution engine + `effective` preview API

Roadmap: `docs/roadmap.md` → **Phase 4**. Blockers **#139 (ADR 0005, closed)**
and **#146 (schema columns, merged)** are both resolved.

## Goal

The single "what applies for user U on day D" resolver, plus a
`GET /api/users/:userId/effective?date=YYYY-MM-DD` preview endpoint. Every
downstream surface (timekpra allowed-hours push #140, per-activity enforcement
#98/#99, burndown #62, save-and-push diff #64) reads this one resolver instead
of re-deriving precedence/recurrence/budget rules.

## Authoritative spec

- **ADR 0005** (`docs/adr/0005-recurrence-and-date-scoping.md`) → "How this
  composes with ADR 0004" gives the exact **active-at-`T`** predicate:
  1. *Date gate* — `effective_from` is NULL or `≤ T`, and `effective_to` is
     NULL or `> T`.
  2. *Recurrence gate* — always-on degenerate, or the local ISO weekday of
     `T` is in `recurrence_days` (when set) **and** the local minute-of-day of
     `T` is in `[start, end)` (when set).
  Evaluated in the user's effective TZ (`User.tz ?? PCT_DEFAULT_TZ`).
- **ADR 0004** + `policy/schedule-precedence.ts`: first-match-wins by
  `ordinal` (ties by `id`). That module already exposes a
  `RuleActivePredicate` seam *expressly left for #143* — this resolver is the
  predicate it was waiting for.
- **ADR 0001** + `policy/budget-window.ts`: UTC storage; local time enters
  only at resolution. Reuse it for day boundaries / TZ math.

## Design decisions (locked)

- **`allowedWindows` are local minutes-of-day** `{ start, end }` half-open
  intervals, **not** UTC instants. ADR 0005 §1 fixes the intra-day window as
  minutes-from-local-midnight that map 1:1 to Timekpr-nExT per-weekday
  allowed-hours; keeping the output in local minutes is the natural contract
  and is DST-agnostic (no sub-day instant math).
- **Scope of `allowedWindows` = `overall`** schedule rules. Activity/group
  schedule rules surface in `activeRules` (all scopes) so a preview UI can
  show them, but the resolved access window is the overall-session schedule.
- **Action handling:** `deny` blocks; `allow`/`extend` permit; the baseline
  when no rule is active is **allow** (ADR 0004). So a minute is in an allowed
  window iff the winning overall rule's action is not `deny`.
- **Budgets:** `overallSeconds` = sum of `scope=overall, window=daily`
  budgets + active overall grants overlapping day D; `null` when no daily
  overall budget exists (no daily limit — a grant on an unlimited base is
  moot). `perActivitySeconds` likewise per `(scope, targetId)` that has a
  daily budget.
- **Grant overlap:** a grant counts for day D if `revoked_at IS NULL` and its
  `[granted_at, expires_at)` overlaps the day's `[start, end)` UTC bounds.
  Full seconds counted (partial-day expiry is an enforcement subtlety, out of
  scope for the preview).
- **Exceptions are deferred** to #142 (date-specific overrides) — ADR 0005
  groups exception/override composition with #142's cross-layer ordering;
  building it here would code against an undecided contract.
- **Date gate in the day-window builder is day-granular** (candidate iff the
  effective window overlaps the day); the per-instant `isRuleActiveAt`
  predicate is exact. ADR 0005 fixes effective bounds at local-day
  boundaries, so this is exact for all in-contract inputs and documented.
- **JSON casing:** camelCase response keys (matches existing `/api/policy`
  DTOs: `displayName`, `enrolledAt`), despite the issue sketch's snake_case.

## Conflict avoidance with in-flight PRs

- Row reads done inline in the route file, **not** by extending
  `policy/repository.ts` (which PR #160 grows) → no shared-file churn.
- New route lives in its own `api/policy/effective.ts` + a one-line
  registration in `api/plugin.ts`; does not touch `api/policy/routes.ts`
  (PR #160's file).
- `budget-window.ts` additions are purely additive and that module is stable
  (not touched by any open PR).

## Phases

**Phase A — pure resolver + window helpers + unit tests**
- `policy/budget-window.ts`: add `localDayBounds(year, month, day, tz)`,
  `localCalendarDate(instant, tz)`, `isoWeekday(year, month, day)` (exported,
  reused by #141/#142 later).
- `policy/resolve.ts`: `isRuleActiveAt` / `ruleActiveAt(instant, tz)` (the
  `RuleActivePredicate`), `effectivePolicy(input)`. Pure, no DB.
- Re-export from `policy/index.ts`.
- Tests: `tests/policy/resolve.test.ts`, extend
  `tests/policy/budget-window.test.ts`. Cover: date/recurrence gates, weekday
  mask edges, DST day, first-match-wins window composition, deny/allow/extend,
  baseline allow, grant overlap, daily-only budget selection, null overall.

**Phase B — DTOs + `GET …/effective` route + route tests**
- `api/policy/effective.ts`: zod DTOs (`effectivePolicyResponseSchema`, date
  querystring), `registerEffectiveRoutes(scope, settings)`, inline row reads.
- Register in `api/plugin.ts`; export DTOs from `api/policy/index.ts`.
- Tests: `tests/api/policy-effective.test.ts` (happy path, default-date,
  404 unknown user, 401 guard, bad date 400, future-date preview).

## Quality gate (per phase, from `server/`)
`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test`
(coverage gate 80%).

## License-boundary note
Pure TypeScript + zod + Drizzle/better-sqlite3. No GPL linkage, no
subprocess/REST boundary change, no Docker-image change. `license-guard`
unaffected. No new dependency.

## Deferred (tracked)
- Exception/date-override composition → **#142**.
- Weekday-varying budget composition → **#141**.
- timekpra allowed-hours translation of `allowedWindows` → **#140**.
- Wiring the resolver into the save-and-push preview diff UI → **#64**.
