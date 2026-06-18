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

// Auth DTOs (#52). Re-exported here so the frontend imports the auth contract
// from the same `/api` surface as every other DTO; the schemas themselves live
// in `../auth/dtos.ts` next to the routes that use them.
export {
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse,
} from "../auth/dtos.js";
