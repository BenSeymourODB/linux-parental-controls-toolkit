/**
 * Durable store for the offline transport queue (#84).
 *
 * Thin, synchronous Drizzle functions over the shared {@link PolicyDb} handle,
 * mirroring `policy/repository.ts`: no HTTP or scheduling concerns live here —
 * the {@link ../drainer.ts} replay loop and the {@link ../scheduler.ts} croner
 * job compose these. Coalescing is delegated to the storage layer: the UNIQUE
 * `(client_id, coalesce_key)` index plus the {@link enqueue} upsert mean a
 * newer push for the same target replaces the older queued one in place
 * (keeping its FIFO position) rather than piling up.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT).
 */
import { and, asc, eq, sql } from "drizzle-orm";

import type { PolicyDb } from "../../policy/db.js";
import { transportQueue } from "../../policy/schema.js";
import type { NewQueuedAction, QueuedActionRow } from "./types.js";

/** A per-client count of outstanding (`pending`) actions. */
export interface PendingCount {
  readonly clientId: number;
  readonly count: number;
}

/**
 * Enqueue an action, coalescing onto any existing row for the same
 * `(clientId, coalesceKey)`: the newer `kind`/`payload` wins and the row is
 * reset to `pending` with `attempts` cleared, so a fresh desired state isn't
 * suppressed by a stale dead-lettered (`failed`) attempt. `enqueued_at` is
 * left untouched on coalesce, preserving the row's original FIFO position;
 * `updated_at` advances. Returns the stored row.
 */
export function enqueue(db: PolicyDb, action: NewQueuedAction): QueuedActionRow {
  return db
    .insert(transportQueue)
    .values({
      clientId: action.clientId,
      coalesceKey: action.coalesceKey,
      kind: action.kind,
      payload: action.payload,
    })
    .onConflictDoUpdate({
      target: [transportQueue.clientId, transportQueue.coalesceKey],
      set: {
        kind: action.kind,
        payload: action.payload,
        status: "pending",
        attempts: 0,
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .returning()
    .get();
}

/** A client's `pending` actions, oldest first — the order the drainer replays. */
export function listPendingForClient(db: PolicyDb, clientId: number): QueuedActionRow[] {
  return db
    .select()
    .from(transportQueue)
    .where(and(eq(transportQueue.clientId, clientId), eq(transportQueue.status, "pending")))
    .orderBy(asc(transportQueue.id))
    .all();
}

/**
 * Every queued row for a client (`pending` and dead-lettered `failed`), oldest
 * first — the read the admin Clients page (#81) and the save-and-push preview
 * (#64) render to show "what's pending / what got stuck".
 */
export function listForClient(db: PolicyDb, clientId: number): QueuedActionRow[] {
  return db
    .select()
    .from(transportQueue)
    .where(eq(transportQueue.clientId, clientId))
    .orderBy(asc(transportQueue.id))
    .all();
}

/**
 * Distinct client ids that have at least one `pending` action, ascending — the
 * candidate set the scheduler probes each tick.
 */
export function clientsWithPending(db: PolicyDb): number[] {
  return db
    .selectDistinct({ clientId: transportQueue.clientId })
    .from(transportQueue)
    .where(eq(transportQueue.status, "pending"))
    .orderBy(asc(transportQueue.clientId))
    .all()
    .map((row) => row.clientId);
}

/** Per-client counts of outstanding (`pending`) actions, ascending by client. */
export function countPendingByClient(db: PolicyDb): PendingCount[] {
  return db
    .select({ clientId: transportQueue.clientId, count: sql<number>`count(*)` })
    .from(transportQueue)
    .where(eq(transportQueue.status, "pending"))
    .groupBy(transportQueue.clientId)
    .orderBy(asc(transportQueue.clientId))
    .all();
}

/**
 * Remove a successfully-drained action. Returns whether a row was deleted (it
 * won't be if a concurrent enqueue coalesced/replaced it first). Drained work
 * is deleted rather than archived — the audit of *issued* commands is #85's
 * separate, append-only log.
 */
export function markDrained(db: PolicyDb, id: number): boolean {
  return (
    db
      .delete(transportQueue)
      .where(eq(transportQueue.id, id))
      .returning({ id: transportQueue.id })
      .get() !== undefined
  );
}

/**
 * Record a failed-but-retriable attempt: bump `attempts`, store `last_error`,
 * and **keep** the row `pending` so it is replayed on a later tick (a missed
 * push is never silently dropped). Returns the updated row, or `undefined` if
 * it no longer exists.
 */
export function recordAttempt(
  db: PolicyDb,
  id: number,
  lastError: string,
): QueuedActionRow | undefined {
  return db
    .update(transportQueue)
    .set({ attempts: sql`${transportQueue.attempts} + 1`, lastError, updatedAt: new Date() })
    .where(eq(transportQueue.id, id))
    .returning()
    .get();
}

/**
 * Dead-letter an action: bump `attempts`, store `last_error`, and move it to
 * `failed` so it no longer blocks the queue head while staying visible to the
 * admin. Used for non-retriable failures (the command itself is wrong —
 * replaying it unchanged won't help). Returns the updated row, or `undefined`
 * if it no longer exists.
 */
export function markFailed(
  db: PolicyDb,
  id: number,
  lastError: string,
): QueuedActionRow | undefined {
  return db
    .update(transportQueue)
    .set({
      status: "failed",
      attempts: sql`${transportQueue.attempts} + 1`,
      lastError,
      updatedAt: new Date(),
    })
    .where(eq(transportQueue.id, id))
    .returning()
    .get();
}
