/**
 * zod DTOs for the transport-audit read API (#85), shared with the frontend and
 * external integrators (the single `/api/*` contract).
 *
 * The audit log is read-only over HTTP — there is no write DTO; entries are
 * produced by the `transport/audit` recorder, never by a request. Timestamps
 * serialise as ISO-8601 strings (the storage layer keeps UTC epoch seconds).
 */
import { z } from "zod";

import { auditOutcomeSchema } from "../../policy/enums.js";
import type { AuditEntryRow } from "../../transport/audit/index.js";

/** Default page size when the request omits `limit`. */
export const DEFAULT_AUDIT_LIMIT = 50;
/** Hard cap on page size, so one request can't scan the whole table. */
export const MAX_AUDIT_LIMIT = 200;

/**
 * Querystring for `GET /api/audit`. Query params arrive as strings, so the
 * numeric fields are coerced; `limit` defaults and is bounded.
 */
export const listAuditQuerySchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  outcome: auditOutcomeSchema.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_AUDIT_LIMIT).default(DEFAULT_AUDIT_LIMIT),
});

/** The inferred, validated query for the audit list route. */
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

/** One audit entry on the wire. */
export const auditEntryResponseSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  targetHost: z.string(),
  targetPort: z.number().int(),
  targetUser: z.string(),
  clientId: z.number().int().nullable(),
  userId: z.number().int().nullable(),
  actor: z.string(),
  reason: z.string().nullable(),
  command: z.array(z.string()),
  outcome: auditOutcomeSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int(),
  errorMessage: z.string().nullable(),
});

/** The inferred shape of one audit entry response. */
export type AuditEntryResponse = z.infer<typeof auditEntryResponseSchema>;

/**
 * A page of audit entries (newest-first) plus the cursor to fetch the next,
 * older page. `nextCursor` is the last entry's id when a full page was returned
 * (more may exist), or `null` when the page was not full (end of the log).
 */
export const auditListResponseSchema = z.object({
  entries: z.array(auditEntryResponseSchema),
  nextCursor: z.number().int().nullable(),
});

/** The inferred shape of the audit list response. */
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

/** Serialise a persisted audit row to its wire DTO. */
export function toAuditResponse(row: AuditEntryRow): AuditEntryResponse {
  return {
    id: row.id,
    at: row.at.toISOString(),
    targetHost: row.targetHost,
    targetPort: row.targetPort,
    targetUser: row.targetUser,
    clientId: row.clientId,
    userId: row.userId,
    actor: row.actor,
    reason: row.reason,
    command: row.command,
    outcome: row.outcome,
    exitCode: row.exitCode,
    signal: row.signal,
    durationMs: row.durationMs,
    errorMessage: row.errorMessage,
  };
}
