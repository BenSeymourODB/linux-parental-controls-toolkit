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

// Post-enrol connectivity verification (#354): the client-bearer-authenticated
// verify-connection route + its response DTO.
export {
  registerClientVerifyRoutes,
  VERIFY_RATE_LIMIT_MAX_ATTEMPTS,
  VERIFY_RATE_LIMIT_WINDOW_MS,
  type ClientVerifyRoutesDeps,
} from "./verify-routes.js";
export {
  verifyConnectionResponseSchema,
  sshUnreachableReasonSchema,
  type VerifyConnectionResponse,
} from "./verify-dtos.js";

// Client health/status surface (#81): the read-only health routes + the DTOs
// the admin "Clients" page consumes.
export { registerClientHealthRoutes, type ClientHealthRoutesDeps } from "./health-routes.js";
export {
  clientHealthSchema,
  clientHealthListSchema,
  clientQueueSchema,
  componentHealthSchema,
  queuedActionSummarySchema,
  toQueuedActionSummary,
  type ClientHealthResponse,
  type ClientQueueDto,
  type ComponentHealthDto,
  type QueuedActionSummary,
} from "./health-dtos.js";
