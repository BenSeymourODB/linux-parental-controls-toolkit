# Plan — #136 Retention: policy model + configuration (backend slice)

Roadmap: `docs/roadmap.md` → Phase 11 (epic #135). Part of #135; unblocks
#137 (scheduled purge job) and #138 (per-entity purge coverage).

## Scope (this PR)

Backend only:

1. **Category vocabulary** — the set of *dated* data classes retention can
   target, grounded in **ADR 0005 §4** (recurrence rules are not dated data and
   are never purged):
   - `usage_samples` — ActivityWatch usage history
   - `grant_ledger` — the immutable `Grant` ledger
   - `audit_log` — transport audit entries
   - `date_overrides` — date-specific policy rows wholly in the past
     (an `exception` past `expires_at`, a `schedule` past `effective_to`)

   The issue's illustrative list named `schedule_history` / `budget_history`;
   there are no such tables (schedules/budgets are live recurrence rules, not
   dated history — ADR 0005 §4), so they are intentionally **not** categories.
   Documented in code + PR.

2. **Config model** — a global default window (`365` days, env-overridable via
   `PCT_RETENTION_DEFAULT_DAYS`) plus optional per-category overrides persisted
   in the policy store. Each override is either a custom positive day count or
   "keep forever".

3. **Pure helpers** (`policy/retention.ts`) — `resolveRetention`,
   `isExpired(timestamp, resolved, now)`, and a `RetentionPolicy` resolver
   exposing `isExpired(category, ts, now)` so the rule lives in one place for
   the purge job (#137/#138). UTC throughout (ADR 0001).

4. **Persistence** — `retention_overrides` table (category PK, `keep_forever`,
   `days`, coherence CHECK), one timestamp-prefixed migration, repo functions
   in `policy/repository.ts`.

5. **`/api/*`** behind `requireAdmin`:
   - `GET /api/retention` — resolved config (default + every category)
   - `PUT /api/retention/:category` — set an override (custom days | keep forever)
   - `DELETE /api/retention/:category` — clear an override (revert to default)
   zod DTOs shared via the `api/` barrel.

## Deferred (follow-up issue, linked from PR)

- Admin UI surface to view/adjust windows — depends on the in-flight admin
  shell (#53). The JSON API + DTOs land here so the UI is a thin follow-up.

## Phases

1. enums + pure model + schema + migration + tests
2. repository + config wiring + tests
3. `/api/retention` routes + DTOs + HTTP tests + docs

## License boundary

N/A — plain TypeScript + zod + Drizzle (better-sqlite3 MIT, drizzle Apache-2.0).
No GPL linkage, no transport/packaging change.
