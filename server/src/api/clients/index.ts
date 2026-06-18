/**
 * Client-enrolment surface (#77): the route registrar plus the zod DTOs and
 * inferred types the frontend and install script consume. Re-exported from the
 * top-level `api/` barrel so the whole `/api` contract imports from one place.
 */
export { registerClientEnrolmentRoutes, parseBearer } from "./routes.js";
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
