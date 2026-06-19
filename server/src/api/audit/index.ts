/**
 * Transport-audit read API (#85): the route registrar plus the zod DTOs and
 * inferred types the frontend and integrators consume. Re-exported from the
 * top-level `api/` barrel so the contract is imported from one place.
 */
export { registerAuditRoutes } from "./routes.js";
export {
  auditEntryResponseSchema,
  auditListResponseSchema,
  listAuditQuerySchema,
  toAuditResponse,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  type AuditEntryResponse,
  type AuditListResponse,
  type ListAuditQuery,
} from "./dtos.js";
