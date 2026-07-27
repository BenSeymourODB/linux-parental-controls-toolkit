/**
 * Durable telemetry pull cursor (#382): the persistence half of the Phase-5
 * per-client pull cursor.
 *
 * `enforcement/telemetry-consumer.ts` keeps an in-memory `Map<clientId, Date>`
 * of the last successfully-pulled window `end` so overlapping passes within one
 * process don't double-count. This module promotes that cursor to a **durable**
 * one on the `clients.last_telemetry_pull_at` column, so a dashboard restart
 * resumes each client's pull exactly where it left off instead of re-pulling
 * the whole `initialLookback` window (a bounded double-count against
 * already-persisted samples).
 *
 * The cursor lives on `clients` (not a separate table) because it is strictly
 * 1:1 with a client and dies with it — no orphan rows, no extra FK — mirroring
 * the existing nullable-timestamp columns (`last_seen`, `versions_reported_at`).
 * A `NULL` column is the "no successful pull yet" state the pull reads as
 * "fall back to `initialLookback`".
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT)
 * reads/writes only; no GPL surface, no transport call.
 */
import { eq, isNotNull } from "drizzle-orm";

import type { PolicyDb, PolicyTx } from "./db.js";
import { clients } from "./schema.js";

/**
 * Every client with a persisted cursor, as a `clientId → last-pulled-end` map —
 * the seed the pull loads into its in-memory cursor on boot. Clients with no
 * successful pull yet (`NULL`) are absent from the map, so the pull falls back
 * to `initialLookback` for them exactly as it does on a cold start.
 */
export function loadTelemetryCursors(db: PolicyDb): Map<number, Date> {
  const rows = db
    .select({ clientId: clients.id, lastTelemetryPullAt: clients.lastTelemetryPullAt })
    .from(clients)
    .where(isNotNull(clients.lastTelemetryPullAt))
    .all();
  const cursors = new Map<number, Date>();
  for (const row of rows) {
    // The `isNotNull` filter guarantees this, but the column type is nullable;
    // the guard narrows `Date | null → Date` without an unchecked cast.
    if (row.lastTelemetryPullAt !== null) cursors.set(row.clientId, row.lastTelemetryPullAt);
  }
  return cursors;
}

/**
 * Persist a client's cursor advance. Called at the same point the in-memory
 * cursor advances — after a successful `UsageSample` insert — so the two stay
 * in lock-step and a mid-pull failure (which throws before this runs) leaves
 * both unmoved, re-pulling the same window next pass.
 */
export function saveTelemetryCursor(db: PolicyDb | PolicyTx, clientId: number, end: Date): void {
  db.update(clients).set({ lastTelemetryPullAt: end }).where(eq(clients.id, clientId)).run();
}
