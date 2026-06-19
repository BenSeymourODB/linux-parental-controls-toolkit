/**
 * Read queries over the `audit_log` table (#85) for the admin audit view.
 *
 * Reads only — entries are written exclusively through {@link ./sink.ts}'s
 * `DrizzleAuditSink`, never updated. The list is newest-first with id-cursor
 * pagination: `id` is monotonic, so "older than the last row I saw" is a stable
 * `id < before` predicate that never skips or repeats an entry as new ones land.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT).
 */
import { and, desc, eq, lt, type SQL } from "drizzle-orm";

import type { PolicyDb } from "../../policy/db.js";
import type { AuditOutcome } from "../../policy/enums.js";
import { auditLog } from "../../policy/schema.js";

/** A persisted audit-log row. */
export type AuditEntryRow = typeof auditLog.$inferSelect;

/** Filters and pagination for {@link listAuditEntries}. */
export interface AuditQuery {
  /** Restrict to one enrolled client. */
  readonly clientId?: number;
  /** Restrict to one outcome class. */
  readonly outcome?: AuditOutcome;
  /** Return entries strictly older (smaller id) than this cursor. */
  readonly before?: number;
  /** Maximum rows to return (the caller's DTO bounds this). */
  readonly limit: number;
}

/**
 * List audit entries newest-first, applying the optional `clientId`/`outcome`
 * filters and the `before` id cursor, capped at `limit`.
 */
export function listAuditEntries(db: PolicyDb, query: AuditQuery): AuditEntryRow[] {
  const conditions: SQL[] = [];
  if (query.clientId !== undefined) conditions.push(eq(auditLog.clientId, query.clientId));
  if (query.outcome !== undefined) conditions.push(eq(auditLog.outcome, query.outcome));
  if (query.before !== undefined) conditions.push(lt(auditLog.id, query.before));

  const base = db.select().from(auditLog);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return filtered.orderBy(desc(auditLog.id)).limit(query.limit).all();
}
