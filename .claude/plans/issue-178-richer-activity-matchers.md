# Plan — #178 Usage normalisation: richer activity matchers + app_group resolution

Roadmap: `docs/roadmap.md` → Phase 5. Builds on #88
(`transport/activitywatch/normalise.ts`, `policy/usage.ts`). Backend-only;
no UI (the Activity matcher editor stays in #53/#63).

## Problem (today's v1, from #88)

`normaliseWindowEvents` resolves a window event's foreground `app` to an
`Activity` by **case-insensitive exact match**, and only for `app`-kind
activities (`buildAppMatchIndex` skips every other kind). `app_group`,
`domain`, `domain_group` yield no samples. The matcher grammar is
unspecified — there is no substring/glob/regex support and no defined
precedence when several activities could match one event.

## Scope this PR

1. **ADR 0006 — activity matcher grammar.** Define the matcher contract the
   Activity editor (#53) will write against:
   - A new `match_type` discriminator on `Activity`: `exact` (default,
     == today's behaviour), `substring`, `glob`, `regex`. All matching is
     case-insensitive against the AW `app` string.
   - **Precedence** when several activities match one event:
     `exact` beats any pattern match; within the same tier the **lowest
     activity id wins** (deterministic, == v1's collision rule). Documented
     as the floor; explicit admin-ordered precedence is editor work (#63).
   - `glob` = `*`/`?` wildcards only (anchored, whole-string), compiled to a
     bounded regex — no alternation/backtracking surface.
   - `regex` posture: admin-supplied, validated to compile at write time;
     matched against short app strings; household single-admin threat model
     (ReDoS bounded, noted, not a hardening project per CLAUDE.md).
   - **`app_group`** resolves from window events by the *same* grammar (a
     bundle is "an activity whose matcher matches several apps"), distinct
     from the `activities_to_groups` rollup M2M.
   - **`domain` / `domain_group`** explicitly DEFERRED: they match web
     requests sourced from web-proxy telemetry (e2guardian Phase 6 / AdGuard
     Phase 7), which does not exist yet. The ADR records the intended
     contract; implementation tracked by a new follow-up issue.

2. **Schema** — add `match_type TEXT NOT NULL DEFAULT 'exact'` + CHECK to
   `activities`; new `matchTypeValues` enum in `policy/enums.ts`. Migration
   via `npm run db:generate` (timestamp-prefixed, #133). Degenerate default
   = `exact` so every existing row keeps v1 behaviour with no data migration.

3. **Normaliser** — replace `buildAppMatchIndex` (exact-only, `app`-only)
   with a matcher engine that:
   - considers both `app` and `app_group` kinds,
   - compiles each activity's `(match_type, matcher)` to a predicate,
   - resolves an event's `app` to the winning activity id by the precedence
     above (exact-index fast path + ordered pattern scan).
   The rest of the pipeline (skew guard, afk clip, merge, second-floor) is
   unchanged.

4. **API DTOs** — `match_type` on create/update/response activity schemas
   (`api/policy/dtos.ts`), defaulting to `exact`; `toActivityResponse` carries
   it; regex/glob validated in zod (`.superRefine` compile check).

## Tests (Vitest, unit)

- `policy/enums` + DTO: match-type validation, default, bad regex rejected.
- `migrations.test.ts`: assert `activities.match_type` column present.
- repository/routes: create/patch/response round-trips `match_type`.
- `normalisation.test.ts`: exact (unchanged), substring, glob, regex,
  `app_group` now resolves, `domain`/`domain_group` still ignored, precedence
  (exact-beats-pattern, lowest-id tiebreak), invalid regex never throws in the
  pure transform (validated upstream; transform treats uncompilable as
  no-match defensively).

## Deferred (tracked)

- `domain` / `domain_group` → new follow-up issue (web-proxy telemetry,
  Phase 6/7). Linked from the PR.
- Matcher editor UI + admin-ordered precedence → #53 / #63.

## License boundary

N/A — pure TypeScript + zod + Drizzle (Apache-2.0) / better-sqlite3 (MIT).
No GPL linkage, no subprocess/REST boundary, no Docker-image change.
