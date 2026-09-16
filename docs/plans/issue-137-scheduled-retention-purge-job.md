# Plan — #137 Retention: scheduled automatic purge job (croner) + audit of each run

Epic: #135 (data retention). Prerequisites **merged**: #136 (config model +
`RetentionPolicy` + `isExpired`), #138 (per-entity purge coverage,
`policy/purge.ts` → `purgeExpiredRecords`). Roadmap: Phase 11.

## Goal

The croner-scheduled job that *automatically* enforces the configured retention
windows, plus the operator-facing controls the issue calls for:

- Periodic (daily default) purge that drives `purgeExpiredRecords` and **records
  every run** so purges are observable.
- **Dry-run / preview** mode: count what *would* be purged without deleting.
- **Manual "run now"** trigger from the admin retention page.
- **Last-run summary** surfaced in the admin retention page.

Batched/bounded/interruptible deletes and the grant-ledger constraint are
already handled by the #138 routines; this issue *drives* and *observes* them.

## Design decisions

### Observability: a dedicated purge-run ledger, not the transport `audit_log`

The issue says "record … in the audit log (#85)". The existing `audit_log`
table is **transport-command shaped** — every row requires a `target_host` /
`target_port` / `target_user` and a `command` argv, and its module doc scopes
it to "every command the dashboard issues to a client" (read-only probes are
deliberately excluded). A retention purge is an internal DB-maintenance
operation with no client target and no command; shoehorning it in would
violate that table's documented contract and pollute the client-command trail.

So a purpose-built ledger, `retention_purge_runs`, records each run and directly
powers the "last-run summary" read. It satisfies the same intent — *what
category, how many rows, what cutoff, when, and what triggered it* — in an
honest, queryable shape. (Called out in the PR body as a deliberate deviation.)

One table, following the `audit_log` JSON-column precedent:

```
retention_purge_runs
  id            integer pk autoinc
  at            integer timestamp (unixepoch default)
  trigger       text  in ('scheduled','manual')   -- new enum
  total_deleted integer  >= 0
  duration_ms   integer  >= 0
  items         text json  $type<PurgeRunItem[]>()  -- per-category breakdown
```

`PurgeRunItem = { category, cutoff: epochSeconds | null, deleted }`. Previews
are **not** persisted (a preview is a read, not a run).

### `countExpiredRecords` (dry-run mechanism) in `policy/purge.ts`

`policy/purge.ts` owns the "what/how to purge" mechanism. Add the read-only
counterpart `countExpiredRecords(db, policy, now)` → `CountCategoryResult[]`
(`{ category, cutoff, wouldDelete }`), mirroring `purgeExpiredRecords`'
per-category cutoff logic with `count(*) WHERE <ts> < cutoff` (and the 4-table
sum for `date_overrides`). `keepForever ⇒ cutoff null ⇒ 0`.

### Orchestration lives in a new `src/retention/` module

Mirrors `src/enforcement/` (a non-transport orchestration module):

- `retention/service.ts` — `runRetentionPurge()` (purge + record a run) and
  `previewRetentionPurge()` (count, no record).
- `retention/scheduler.ts` — `createRetentionPurgeScheduler()`: a croner handle
  with `start()/tick()/stop()`; the `Cron` is created lazily in `start()` so
  constructing the app starts no timer (test-safe, matching the enforcement
  pipeline). `protect: true` guards against overlap.
- `retention/index.ts` — barrel.

Repository rows (`recordPurgeRun`, `getLatestPurgeRun`, `listPurgeRuns`) live in
`policy/repository.ts` alongside the retention-override repo functions.

### Config

`config.ts` → `retention.purgeCron` (`PCT_RETENTION_PURGE_CRON`, default
`0 3 * * *` — 03:00 daily; retention is not latency-critical) validated by
`isValidCronPattern`, and `retention.purgeBatchSize`
(`PCT_RETENTION_PURGE_BATCH_SIZE`, default `DEFAULT_PURGE_BATCH_SIZE`).

### Boot wiring (always-on — no SSH dependency)

`buildAppServices` constructs the scheduler (always; a purge needs only the DB),
holds it on `AppServices` + decorates it on the app; `main.ts` calls `start()`
after `listen`; `teardown()` calls `stop()`. Mirrors the enforcement pipeline
lifecycle but with no null/keyless case.

### API (`/api/retention`)

- `POST /api/retention/purge` — run now (`trigger: "manual"`), returns the run
  summary. Admin-only.
- `POST /api/retention/purge/preview` — dry-run, returns per-category
  `wouldDelete`. Admin-only, side-effect-free.
- `GET /api/retention/purge/runs?limit=` — recent runs (newest first); the
  first element is the "last-run summary". Admin-only.

### Admin UI (`RetentionView.svelte`)

The retention config view already exists (#136 UI slice). Add: a "Data purge"
panel showing the last run (when + per-category rows deleted + cutoff), a
"Preview" button (dry-run counts) and a "Run purge now" button, using a small
`$lib/api/retention.ts` extension.

## Phases (commit + push each)

1. **Mechanism + ledger**: `countExpiredRecords`; `retentionPurgeTrigger` enum;
   `retention_purge_runs` table + migration; repository fns;
   `retention/service.ts` + barrel. Unit tests. → opens draft PR.
2. **Scheduler + config + wiring**: `retention/scheduler.ts`; config fields;
   `app-services`/`app`/`main` wiring. Unit + wiring tests.
3. **API**: DTOs + routes. Route tests.
4. **Admin UI**: `RetentionView` purge panel + frontend api + tests; build.

## Deferred (tracked)

- None essential. If UI scope grows, the backend job + API (phases 1–3) is the
  substantive, fully-verifiable slice and the UI panel (phase 4) can be split.

## License boundary

None touched — pure TypeScript + Drizzle over the policy store; croner (MIT).
No GPL linkage, no subprocess/REST boundary, no image change.
