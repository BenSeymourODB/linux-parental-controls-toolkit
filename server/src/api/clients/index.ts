/**
 * Client-enrolment surface (#77): the route registrar plus the zod DTOs and
 * inferred types the frontend and install script consume. Re-exported from the
 * top-level `api/` barrel so the whole `/api` contract imports from one place.
 */
export { registerClientEnrolmentRoutes } from "./routes.js";
export {
  enrolClientSchema,
  enrolResponseSchema,
  mintEnrolmentTokenSchema,
  enrolmentTokenResponseSchema,
  DEFAULT_ENROLMENT_TTL_SECONDS,
  MAX_ENROLMENT_TTL_SECONDS,
  type EnrolClientRequest,
  type EnrolResponse,
  type MintEnrolmentTokenRequest,
  type EnrolmentTokenResponse,
} from "./dtos.js";

// Client health/status surface (#81): the read-only health routes + the DTOs
// the admin "Clients" page consumes.
export { registerClientHealthRoutes, type ClientHealthRoutesDeps } from "./health-routes.js";
export {
  clientHealthSchema,
  clientHealthListSchema,
  clientQueueSchema,
  componentHealthSchema,
  clientCapabilitySchema,
  queuedActionSummarySchema,
  toQueuedActionSummary,
  type ClientHealthResponse,
  type ClientQueueDto,
  type ComponentHealthDto,
  type ClientCapabilityDto,
  type QueuedActionSummary,
} from "./health-dtos.js";
