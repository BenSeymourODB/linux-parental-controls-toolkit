/**
 * Retention configuration API (#136): the route registrar plus the zod DTOs
 * and inferred types the frontend and integrators consume. Re-exported from
 * the top-level `api/` barrel so the contract is imported from one place.
 */
export { registerRetentionRoutes } from "./routes.js";
export {
  retentionCategoryParamsSchema,
  setRetentionOverrideSchema,
  retentionEntryResponseSchema,
  retentionConfigResponseSchema,
  toOverrideEntry,
  defaultEntry,
  toRetentionConfigResponse,
  type RetentionCategoryParams,
  type SetRetentionOverrideRequest,
  type RetentionEntryResponse,
  type RetentionConfigResponse,
} from "./dtos.js";
