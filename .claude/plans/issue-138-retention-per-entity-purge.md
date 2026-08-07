# Plan — #138 Retention: per-entity purge coverage

Roadmap: `docs/roadmap.md` → Phase 11 (epic #135). Follow-up to **#136**
(retention model: `resolveRetention` / `isExpired` / `RetentionPolicy`, the
`retention_overrides` config, and `/api/retention`). Unblocks **#137** (the
croner-scheduled job that *drives* these routines).

## What this delivers

One bounded, idempotent **deletion routine per retention category**, each
driven by the shared `RetentionPolicy` rule so nothing re-implements the age
comparison. The categories are already fixed by #136 (`policy/enums.ts`,
grounded in ADR 0005 §4 — recurrence rules are *not* dated data):

| Category         | Table(s)                              | Age keyed on            | "still active ⇒ keep" guard |
| ---------------- | ------------------------------------- | ----------------------- | --------------------------- |
| `usage_samples`  | `usage_samples`                       | `ended_at`              | interval must be wholly past (`ended_at < cutoff`) |
| `date_overrides` | `exceptions`, `group_exceptions`      | `expires_at`            | `expires_at < cutoff ≤ now` ⇒ already expired |
|                  | `schedules`, `group_schedules`        | `effective_to`          | **only** rows with a non-null `effective_to`; open-ended recurrence rules are never purged |
| `audit_log`      | `audit_log`                           | `at`                    | n/a (no dependents; FKs are `set null`) |
| `grant_ledger`   | `grants`                              | `expires_at`            | `expires_at < cutoff ≤ now` ⇒ already expired (inactive) |

### Why these age keys are safe

- **`usage_samples` → `ended_at`.** A sample covers `[started_at, ended_at)`.
  Keying on the *later* bound means a sample is purged only once its whole
  interval is older than the window, so no in-window burndown/rollup can still
  need it.
- **`date_overrides` → the end of the override's active window.** An exception
  is active during `[effective_from ?? created_at, expires_at)`; a date-scoped
  schedule during `[effective_from, effective_to)`. Keying on the *end*
  (`expires_at` / `effective_to`) means a rule is purged only when it is
  *wholly in the past* — an active or future-dated override
  (`expires_at`/`effective_to ≥ now`) can never satisfy `end < cutoff ≤ now`.
  Schedules with a **null** `effective_to` are open-ended recurring rules (ADR
  0005 §4) and are **never** matched (the predicate requires a non-null
  `effective_to`). Group variants (`group_exceptions` / `group_schedules`)
  carry the same columns and are covered identically — the resolver merges
  user + group rows, so retention must too.
- **`grant_ledger` → `expires_at`.** In this schema revocation is a
  **`revoked_at` column on the same row**, *not* a separate ledger row
  (`schema.ts` grants doc), so purging a grant cannot orphan a revocation from
  its grant — the concern in the issue body assumed a separate-row model that
  does not exist. Keying on `expires_at` means a grant is purged only after it
  has expired (inactive), so an active grant is never purged regardless of its
  ledger age. `grant_ledger` also typically carries a longer / `keepForever`
  window, which `RetentionPolicy` already honours.
- **`audit_log` → `at`.** Straightforward; its FKs to `clients`/`users` are
  `on delete set null`, so purged audit rows have no dependents.

### Cutoff, not row-by-row

`isExpired` is monotonic in the record timestamp: a record is expired iff
`now − ts > days·MS_PER_DAY`, i.e. `ts < now − days·MS_PER_DAY`. So each
category resolves to a single **cutoff instant** and the purge is a set-based
`DELETE WHERE <ts_column> < cutoff` (strict `<`, matching `isExpired`'s strict
`>` — a record exactly `days` old is retained). `keepForever` ⇒ cutoff is
`null` ⇒ nothing is purged.

The cutoff derivation is a new pure helper in `retention.ts` (kept beside the
rule it mirrors, not re-derived in the purge layer):

- `retentionCutoff(retention: ResolvedRetention, now: Date): Date | null`
- `RetentionPolicy.cutoffFor(category, now): Date | null`

with a test asserting `isExpired(ts) ⇔ ts < cutoffFor(...)` at the boundary, so
the two never drift.

### Bounded / interruptible batching

`better-sqlite3`'s bundled SQLite is **not** built with
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, so `DELETE … LIMIT` is unavailable. Batch
by selecting up to `batchSize` primary keys matching the cutoff, then
`DELETE … WHERE id IN (…)`, looping until a short/empty batch. Each batch is
its own implicit transaction (no long-held write lock), so a large first run
never locks the store and an interrupted run simply resumes next tick — the
cutoff predicate is stable, so re-running only ever finds the not-yet-deleted
remainder. `DEFAULT_PURGE_BATCH_SIZE = 1000` (well under SQLite's
variable-count limit for the `IN (…)` binding).

## New code

`server/src/policy/purge.ts`:

- `DEFAULT_PURGE_BATCH_SIZE`
- `interface PurgeCategoryResult { category; cutoff: Date | null; deleted: number }`
- `interface PurgeOptions { batchSize?: number }`
- `purgeUsageSamples(db, policy, now, opts?)`
- `purgeDateOverrides(db, policy, now, opts?)` — sums the four tables under one
  `date_overrides` cutoff
- `purgeAuditLog(db, policy, now, opts?)`
- `purgeGrants(db, policy, now, opts?)`
- `purgeExpiredRecords(db, policy, now, opts?): PurgeCategoryResult[]` — runs
  every category in `retentionCategoryValues` declaration order (the shape
  #137 audits per run)

Batching is factored into a small `purgeByIds(select, deleteByIds, batchSize)`
helper taking two closures, so drizzle's inferred table/column types stay
intact (no `any`, no generics gymnastics) and the loop is unit-testable in
isolation.

Barrel: re-export the public purge surface + `retentionCutoff` from
`policy/index.ts`.

## Tests — `server/tests/policy/purge.test.ts`

Hermetic `testDb()` (FKs on), seeding the minimal FK parents.

- **`retentionCutoff` / `cutoffFor`** (in `retention.test.ts`): `keepForever ⇒
  null`; finite ⇒ `now − days`; boundary equivalence with `isExpired`.
- **usage_samples**: a sample ended past the cutoff is purged; one ended within
  the window is kept; one *started* before but *ended* after the cutoff is
  kept.
- **date_overrides**: expired `exceptions` + `group_exceptions` purged; active
  / future-dated ones kept; date-scoped `schedules` / `group_schedules` past
  `effective_to` purged; **null-`effective_to` (open-ended recurring) rows
  always kept**; a still-open date window kept.
- **audit_log**: entry older than the window purged; recent one kept.
- **grant_ledger**: expired grant purged; **active grant kept even when its
  ledger age exceeds the window** (guards the active-grant invariant); a
  revoked-and-expired grant purged with its `revoked_at` on the same row (no
  orphaning); `keepForever` ⇒ nothing purged.
- **batching**: `batchSize = 2` over > 2 expired rows deletes all of them in
  multiple passes; `deleted` count is exact; a second run is a no-op
  (idempotent/resumable).
- **`purgeExpiredRecords`**: returns one result per category in declaration
  order with correct `cutoff` + `deleted`; a `keepForever` override yields
  `cutoff: null, deleted: 0` for that category and doesn't touch its rows.

## Docs

- `docs/architecture.md` → retention section (if present) / `docs/roadmap.md`
  Phase 11: note that per-entity purge coverage landed and what each category
  keys on. A short subsection documenting the age-key + immutability reasoning
  above.

## License boundary

N/A — pure TypeScript + Drizzle (better-sqlite3 MIT, drizzle Apache-2.0) reads
and deletes over the policy store. No GPL linkage, no subprocess/REST boundary,
no image or dependency change.

## Deferred (tracked → #137)

- The croner-scheduled job that drives these routines, per-run audit-log
  entries, dry-run/preview counts, and the manual "run now" trigger — **#137**
  (sub-2). This PR gives it the deletion primitives + per-category summary
  shape it needs.
