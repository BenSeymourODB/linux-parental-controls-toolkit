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

// Policy CRUD DTOs (#51/#148): the policy-model contract shared with the
// frontend and integrators. Schemas live in `./policy/dtos.ts` next to the
// routes; surfaced here so the whole `/api` contract imports from one barrel.
export {
  // Account/device core (#51)
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
  // Activities, groups + membership (#148)
  activityResponseSchema,
  createActivitySchema,
  updateActivitySchema,
  activityGroupResponseSchema,
  createActivityGroupSchema,
  updateActivityGroupSchema,
  groupIdParamsSchema,
  groupActivityParamsSchema,
  type ActivityResponse,
  type CreateActivityRequest,
  type UpdateActivityRequest,
  type ActivityGroupResponse,
  type CreateActivityGroupRequest,
  type UpdateActivityGroupRequest,
  // User groups + membership (#124)
  createUserGroupSchema,
  updateUserGroupSchema,
  userGroupResponseSchema,
  userGroupMemberParamsSchema,
  type CreateUserGroupRequest,
  type UpdateUserGroupRequest,
  type UserGroupResponse,
  // Budgets (#148)
  budgetResponseSchema,
  createBudgetSchema,
  updateBudgetSchema,
  userIdQuerySchema,
  type BudgetResponse,
  type CreateBudgetRequest,
  type UpdateBudgetRequest,
  // Schedules (#148)
  scheduleResponseSchema,
  createScheduleSchema,
  updateScheduleSchema,
  type ScheduleResponse,
  type CreateScheduleRequest,
  type UpdateScheduleRequest,
  // Exceptions (#148)
  exceptionResponseSchema,
  createExceptionSchema,
  updateExceptionSchema,
  type ExceptionResponse,
  type CreateExceptionRequest,
  type UpdateExceptionRequest,
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

// Auth DTOs (#52). Re-exported here so the frontend imports the auth contract
// from the same `/api` surface as every other DTO; the schemas themselves live
// in `../auth/dtos.ts` next to the routes that use them.
export {
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse,
} from "../auth/dtos.js";
