/**
 * JSON API: zod DTOs and routes shared by both frontends and external
 * integrators.
 *
 * This barrel is the documented import surface for the SvelteKit frontend and
 * for any code that needs the API contract: the inferred request/response
 * types (`z.infer`) and the shared error envelope live here, alongside
 * {@link registerApi} for mounting the routes. See `docs/architecture.md` →
 * "API conventions".
 */
export const moduleName = "api";

export { registerApi, apiPlugin } from "./plugin.js";
export {
  ApiError,
  ApiValidationError,
  errorDetailSchema,
  errorEnvelopeSchema,
  zodIssuesToDetails,
  type ErrorDetail,
  type ErrorEnvelope,
} from "./errors.js";
export { metaResponseSchema, type MetaResponse } from "./meta.js";
export type { ZodTypeProvider } from "./validation.js";

// Policy CRUD DTOs (#51): the account/device-core contract shared with the
// frontend and integrators. Schemas live in `./policy/dtos.ts` next to the
// routes; surfaced here so the whole `/api` contract imports from one barrel.
export {
  clientResponseSchema,
  createClientSchema,
  createUserSchema,
  idParamsSchema,
  linkResponseSchema,
  tzSchema,
  updateClientSchema,
  updateUserSchema,
  upsertLinkSchema,
  userClientParamsSchema,
  userIdParamsSchema,
  userResponseSchema,
  type ClientResponse,
  type CreateClientRequest,
  type CreateUserRequest,
  type LinkResponse,
  type UpdateClientRequest,
  type UpdateUserRequest,
  type UpsertLinkRequest,
  type UserResponse,
} from "./policy/index.js";

// Client-enrolment DTOs (#77): the admin token-mint + install-script enrol
// contract. Schemas live in `./clients/dtos.ts` next to the routes.
export {
  enrolClientSchema,
  enrolResponseSchema,
  mintEnrolmentTokenSchema,
  enrolmentTokenResponseSchema,
  type EnrolClientRequest,
  type EnrolResponse,
  type MintEnrolmentTokenRequest,
  type EnrolmentTokenResponse,
} from "./clients/index.js";

// Transport-audit DTOs (#85): the read-only contract for the admin audit view.
// Schemas live in `./audit/dtos.ts` next to the route.
export {
  auditEntryResponseSchema,
  auditListResponseSchema,
  listAuditQuerySchema,
  type AuditEntryResponse,
  type AuditListResponse,
  type ListAuditQuery,
} from "./audit/index.js";

// Auth DTOs (#52). Re-exported here so the frontend imports the auth contract
// from the same `/api` surface as every other DTO; the schemas themselves live
// in `../auth/dtos.ts` next to the routes that use them.
export {
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse,
} from "../auth/dtos.js";
