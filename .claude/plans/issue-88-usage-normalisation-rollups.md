# Issue #88 — Normalise AW events → UsageSample + budget rollups

Roadmap: `docs/roadmap.md` → Phase 5 ("Normalisation into `UsageSample` rows;
aggregation views").

## Context found in the tree

- `usage_samples` table **already exists** (`policy/schema.ts` lines 360-387,
  committed in migration `0000_broad_slapstick.sql`): `id, user_id, client_id,
  activity_id, started_at, ended_at` (epoch-seconds, UTC), with
  `(user_id, started_at)` and `(user_id, activity_id, started_at)` indexes and a
  non-negative-interval CHECK. **No migration needed.**
- The merged AW REST client (#87, `transport/activitywatch/client.ts`) already
  returns typed `AwWindowEvent[]` (`{ app, title, timestamp, durationSeconds }`)
  and `AwAfkEvent[]` (`{ status: "afk"|"not-afk", timestamp, durationSeconds }`).
- `policy/budget-window.ts` (#143 era) provides `effectiveWindow(window, now,
  tz, change?)` → `{ start, end, tz }` half-open UTC bounds, TZ-pinned per
  ADR 0001/0003. Reuse it for every rollover boundary.
- Activity matchers: `activities (id, kind=app|app_group|domain|domain_group,
  matcher)` and `activities_to_groups` M2M. Matcher *semantics* are undefined in
  the docs — this issue defines a v1 (below).

## Independence from in-flight PRs

- #160 (open) grows the policy CRUD in `policy/repository.ts` (Activity/Budget/
  Schedule/Exception CRUD). To avoid stepping on it, all new DB access here goes
  in a **new** `policy/usage.ts`, not `repository.ts`.
- #162 (open) is the telemetry *pull*; it deliberately left a `consume(baseUrl,
  client)` seam for exactly this normaliser. Wiring the normaliser into the
  scheduled pull is **out of scope here** — delivered as composable units, like
  #162/#161 did.
- No schema change → no migration filename collision with any open PR.

## Matcher semantics (v1, this issue defines it)

AW window events carry `app` + `title`. This issue resolves only **`app`-kind**
activities, by **case-insensitive exact match** of the event `app` against the
activity `matcher`. Rationale: AW app identifiers are stable process names; exact
(case-insensitive) is predictable and has no glob/regex ambiguity. Unmatched
apps produce **no** sample (the FK requires a real `activity_id`; we never
fabricate one). `domain*`/`*_group` kinds are not resolvable from window events
(domains come from web-proxy telemetry, group-kinds are client-expanded
bundles) → out of scope here, tracked as a follow-up issue. Group-level
*rollups* still work via the `activities_to_groups` M2M (a group's consumption =
Σ of its member activities).

## Phase A — pure normaliser (`transport/activitywatch/normalise.ts`)

`normaliseWindowEvents(input) → UsageSampleCandidate[]` where
`UsageSampleCandidate = { userId, clientId, activityId, startedAt, endedAt }`.

Steps, in order:
1. Build a case-insensitive `app → activityId` index over kind=`app` activities
   (lowest id wins on a duplicate matcher; documented).
2. Per window event: `start = timestamp`, `end = start + durationSeconds`.
   - **Future-skew drop**: drop if `start > now + tolerance`
     (`tolerance = 60s`, per `docs/testing.md`). Events ≤60s future are kept.
   - **Empty interval**: drop if `durationSeconds <= 0`.
   - Resolve `app → activityId`; drop if unmatched.
3. **AFK clip**: if `afkEvents` has ≥1 entry, intersect each candidate interval
   with the union of `not-afk` intervals (a candidate may split into several).
   Absent/empty afk input → no clip (no info → don't zero; conservative against
   spurious deductions, per the issue's "missing telemetry credits no
   consumption, never punitive").
4. **Dedup/merge** overlapping or adjacent intervals **per activity** (the
   clock-skew artifact in `docs/testing.md`).

Tests `tests/transport/activitywatch/normalisation.test.ts` — the docs/testing.md
checklist plus: unmatched-app drop, zero-duration drop, case-insensitive match,
afk clip (full/partial/split/none), per-activity merge, multi-activity kept
separate, empty input → empty.

## Phase B — repository + rollups (`policy/usage.ts`)

- `insertUsageSamples(db, samples) → number` — bulk insert; no-op on empty. (Cross
  -pull dedup is the pull layer's concern, #162; documented.)
- `activitySecondsInWindow(db, {userId, activityId, window, now, tz, change?})` —
  Σ clamped overlap of the user's samples for that activity with the effective
  budget window.
- `usageByActivityInWindow(db, {userId, window, now, tz, change?}) → Map<number,
  number>` — per-activity seconds for the burndown across all the user's
  per-activity budgets.
- `groupSecondsInWindow(db, {userId, groupId, window, now, tz, change?})` — Σ over
  the group's member activities (via `activities_to_groups`).
- `activityTimeline(db, {userId, from, to}) → UsageSampleRow[]` — samples
  overlapping `[from, to)`, ordered by `started_at` (the per-activity timeline).

Overlap math in JS (`max(0, min(end, winEnd) - max(start, winStart))`) after a
windowed, index-served fetch — clearer and more testable than SQL epoch math at
these volumes.

Tests `tests/policy/usage.test.ts` — insert round-trip, window clamping at both
edges, TZ-sensitive boundaries (`America/New_York` daily), per-activity grouping,
group sum, timeline ordering + overlap inclusion, empty results, gap-conservatism
(no samples → 0, never negative).

## Deferred (file follow-up issue, link from PR)

- Richer matchers (substring/glob/regex), `domain*` telemetry, `*_group`-kind
  resolution.
- Wiring the normaliser into #162's scheduled pull `consume()` seam.
- Admin burndown chart (#62) consumes these queries.
