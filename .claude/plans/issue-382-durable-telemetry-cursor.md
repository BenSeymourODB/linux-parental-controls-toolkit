# Plan — #382 Durable per-client telemetry pull cursor (survive restart)

Roadmap: `docs/roadmap.md` → Phase 5 (ActivityWatch telemetry pull).
Issue: #382 (follow-up to #327, which introduced the **in-memory** cursor).

## What exists on `main` (don't rebuild)

- `enforcement/telemetry-consumer.ts` — `createUsageTelemetryConsumer` holds an
  **in-memory** `Map<number, Date>` cursor (last successfully-pulled window
  `end`, keyed by `clientId`). Each pass queries
  `[cursor.get(id) ?? (passEnd − initialLookback), passEnd)` and, only after a
  successful `insertUsageSamples`, advances `cursor.set(id, end)`. A mid-pull
  throw leaves the cursor unmoved so the window re-pulls next pass.
- `enforcement/pipeline.ts` — owns the cursor: `const cursor = new Map()` at
  construction, seeds the consumer + the sweep, pins `currentPassEnd` per pass.
- `policy/usage.ts` — `insertUsageSamples` is a plain append (no uniqueness
  constraint); cross-pull de-dup is explicitly the pull layer's job.
- `policy/schema.ts` — `clients` table (`last_seen`, `versions_reported_at`,
  … all nullable `integer(mode:"timestamp")` columns to mirror).

## The gap this closes

The cursor is process-local, so after a restart a client's first pass re-pulls
the whole `PCT_ENFORCEMENT_INITIAL_LOOKBACK_SECONDS` window (default 900 s),
which overlaps already-persisted samples → a bounded restart double-count.
Persisting the cursor makes the first post-restart window start exactly where
the last successful pull ended: no overlap, no gap.

## Design decision — column vs table

Persist on **`clients`** as a nullable `last_telemetry_pull_at` timestamp
column, not a separate `telemetry_cursors` table. The cursor is strictly 1:1
with a client, dies with the client (no orphan rows, no extra FK/cascade), and
mirrors the existing `last_seen` / `versions_reported_at` nullable-timestamp
columns. `NULL` is the "no cursor yet" state → fall back to `initialLookback`.

**Idempotent-insert alternative (issue's "alternatively/additionally"): not
taken.** Adding a uniqueness constraint / overlap-aware upsert to
`usage_samples` is a larger change with its own semantics question (what is the
natural key of a clipped interval?) and would alter the deliberately-plain
append. The cursor-persistence approach directly fixes the documented restart
overlap with a single nullable column and no change to the write path. Noted in
the PR.

## Phases

### Phase 1 — schema + migration + cursor DB access (+ tests)
- `policy/schema.ts`: add `lastTelemetryPullAt: integer("last_telemetry_pull_at",
  { mode: "timestamp" })` to `clients`, with a doc comment.
- `npm run db:generate` → timestamp-prefixed migration under `server/drizzle/`
  (never hand-numbered, per #133).
- New `policy/telemetry-cursor.ts`:
  - `loadTelemetryCursors(db): Map<number, Date>` — every client with a non-null
    `last_telemetry_pull_at`, as a `clientId → Date` map (seed source on boot).
  - `saveTelemetryCursor(db, clientId, end): void` — persist the advance.
- `tests/policy/telemetry-cursor.test.ts`: save writes the column; load returns
  only non-null rows as a map; save overwrites an earlier value; empty DB → empty
  map.

### Phase 2 — wire persistence into consumer + pipeline (+ tests)
- `telemetry-consumer.ts`: after the existing `cursor.set(client.id, end)`, call
  `saveTelemetryCursor(db, client.id, end)` — same success point, so a mid-pull
  throw still leaves **both** cursors unmoved. Update the module doc block (the
  "does not survive a restart — a durable cursor is tracked as a follow-up" note
  now describes shipped behaviour).
- `pipeline.ts`: seed `const cursor = loadTelemetryCursors(db)` instead of
  `new Map()`. Update the adjacent comment.
- Extend `tests/enforcement/telemetry-consumer.test.ts`: a successful pull
  persists `last_telemetry_pull_at` on the `clients` row; a failed pull leaves it
  `null`.
- Extend `tests/enforcement/pipeline.test.ts`: a client with a persisted cursor
  seeds the in-memory cursor so the first pass's window starts at the persisted
  `end` (not `passEnd − initialLookback`) — asserted via the AW source's observed
  query `start`.

### Phase 3 — finalize
- `cd server && npm run format && npm run lint:fix && npm run typecheck && npm test`
  (coverage ≥ 80%).
- Draft PR (Closes #382), license-boundary note (N/A — Drizzle reads/writes
  only), test plan. Subagent review, address comments, mark ready.

## Guardrails
- License boundary: **N/A** — Drizzle (Apache-2.0) + better-sqlite3 (MIT) only;
  no GPL linkage, no GPL binary in the image, no transport/packaging change.
- No new dependency.
- Never weaken the existing consumer tests; the failure-leaves-cursor-unmoved
  invariant must hold for the persisted cursor too.
