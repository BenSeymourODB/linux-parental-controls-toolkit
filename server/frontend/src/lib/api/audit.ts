/**
 * Read calls for the transport audit log (#85 backend, #183 view).
 *
 * The audit log is **read-only** over HTTP — entries are produced by the
 * `transport/audit` recorder, never by a request — so this exposes a single
 * `listAudit` query. Same proven shape as the other `$lib/api/*` wrappers
 * (#53): a thin typed wrapper over {@link apiFetch}, with the request filters
 * and response type taken from the shared `/api` contract so the frontend never
 * re-declares a DTO.
 *
 * `GET /api/audit` returns one page newest-first plus a `nextCursor`; older
 * pages are walked by passing the previous page's cursor back as `before`.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { AuditListResponse, AuditOutcome } from "./contract.js";

/**
 * Filters for one page of {@link listAudit}. All optional: omitting every field
 * fetches the most recent page across all clients/outcomes at the default size.
 */
export interface ListAuditParams {
  /** Narrow to commands issued to one client. */
  clientId?: number;
  /** Narrow to one outcome (`ok` / `failed` / `unreachable` / …). */
  outcome?: AuditOutcome;
  /** Id cursor: return entries older than this id (the prior page's cursor). */
  before?: number;
  /** Page size (server bounds it to 1..200). */
  limit?: number;
}

/**
 * Fetch one page of audit entries (newest-first) plus the cursor for the next,
 * older page. Builds the querystring from whichever filters are supplied.
 */
export function listAudit(params: ListAuditParams = {}): Promise<AuditListResponse> {
  const query = new URLSearchParams();
  if (params.clientId !== undefined) {
    query.set("clientId", String(params.clientId));
  }
  if (params.outcome !== undefined) {
    query.set("outcome", params.outcome);
  }
  if (params.before !== undefined) {
    query.set("before", String(params.before));
  }
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }
  const qs = query.toString();
  return apiFetch<AuditListResponse>(`/audit${qs.length > 0 ? `?${qs}` : ""}`);
}
