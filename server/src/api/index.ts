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
  // Group-targeted schedules + exceptions (#182)
  createGroupScheduleSchema,
  groupScheduleResponseSchema,
  type CreateGroupScheduleRequest,
  type GroupScheduleResponse,
  createGroupExceptionSchema,
  groupExceptionResponseSchema,
  type CreateGroupExceptionRequest,
  type GroupExceptionResponse,
  // "Add time today" same-day adjustment (#257)
  adjustTimeTodaySchema,
  timeTodayResponseSchema,
  clientAdjustmentResultSchema,
  toTimeLeftCommand,
  TIME_TODAY_MAX_SECONDS,
  type AdjustTimeTodayRequest,
  type TimeTodayResponse,
  type ClientAdjustmentResultDto,
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

// Client health/status DTOs (#81): the contract the admin "Clients" page reads
// (per-client reachability, component health, offline + queued-change state).
export {
  clientHealthSchema,
  clientHealthListSchema,
  clientQueueSchema,
  componentHealthSchema,
  queuedActionSummarySchema,
  type ClientHealthResponse,
  type ClientQueueDto,
  type ComponentHealthDto,
  type QueuedActionSummary,
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

// Usage-views DTOs (#62): the read-only contract for the admin burndown chart
// and per-activity timeline. Schemas live in `./usage/dtos.ts` next to the route.
export {
  budgetBurndownRowSchema,
  burndownQuerySchema,
  burndownResponseSchema,
  timelineActivitySchema,
  timelineQuerySchema,
  timelineResponseSchema,
  timelineSampleSchema,
  usageParamsSchema,
  type BudgetBurndownRow,
  type BurndownQuery,
  type BurndownResponse,
  type TimelineActivity,
  type TimelineQuery,
  type TimelineResponse,
  type TimelineSample,
} from "./usage/index.js";

// DNS-status DTO (#95): the read-only contract surfacing the active AdGuard mode
// and its health. Schema lives in `./dns/dtos.ts` next to the route.
export {
  dnsModeSchema,
  dnsHealthSchema,
  dnsStatusResponseSchema,
  type DnsStatusResponse,
} from "./dns/index.js";

// System-status DTO (#39): the read-only contract surfacing first-run subsystem
// health (the Ansible venv bootstrap). Schema lives in `./system/dtos.ts`.
export {
  ansibleVenvStateSchema,
  ansibleVenvStatusResponseSchema,
  type AnsibleVenvStatusResponse,
  adGuardManagedStateSchema,
  adGuardManagedStatusResponseSchema,
  type AdGuardManagedStatusResponse,
} from "./system/index.js";

// Auth DTOs (#52). Re-exported here so the frontend imports the auth contract
// from the same `/api` surface as every other DTO; the schemas themselves live
// in `../auth/dtos.ts` next to the routes that use them.
export {
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse,
} from "../auth/dtos.js";

// Event-stream taxonomy (#100): the `/api/events/stream` wire contract — the
// five server-pushed events and the frame envelope. Re-exported here so the
// client bridge (#101) and any consumer share one definition; the schemas live
// in `../events/taxonomy.ts` next to the stream route.
export {
  serverEventSchema,
  eventFrameSchema,
  grantAppliedSchema,
  policyChangedSchema,
  enforceForceCloseSchema,
  enforceSessionLockSchema,
  lockoutClearedSchema,
  type ServerEvent,
  type ServerEventType,
  type EventFrame,
} from "../events/index.js";
