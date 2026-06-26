/**
 * The frontend's single import surface for the `/api` contract.
 *
 * Per `CLAUDE.md` ("Validation / DTOs") and #53, the frontend never
 * hand-writes a parallel DTO: it consumes the **inferred zod types** from the
 * server `/api` source. These are `import type` re-exports, so they are erased
 * at build time — `vite build` never bundles server code, and there is no
 * runtime coupling across the process boundary. `svelte-check` resolves the
 * server graph's bare imports (`zod`, `drizzle-orm`) from `server/node_modules`
 * (the CI `frontend-build` job installs the server package first).
 *
 * License boundary: type-only; no GPL surface. zod (MIT) / drizzle (Apache-2.0)
 * are pulled in only for type resolution, never linked into the frontend bundle.
 *
 * Why the DTO-definition modules rather than the `server/src/api/index.ts`
 * barrel: that barrel also re-exports runtime *values* (route/plugin
 * registrars), and type-checking those drags in the server's route handlers,
 * which depend on Fastify module augmentation (`scope.db`, `requireAdmin`) that
 * is not part of the frontend's type program. Importing the DTO modules
 * directly keeps the graph type-only and self-contained while still consuming
 * the single source-of-truth zod inferences (no DTO is re-declared here).
 */
export type { SessionResponse, LoginRequest } from "../../../../src/auth/dtos.js";
export type {
  UserResponse,
  CreateUserRequest,
  UpdateUserRequest,
  ClientResponse,
  CreateClientRequest,
  UpdateClientRequest,
  ActivityResponse,
  CreateActivityRequest,
  UpdateActivityRequest,
  ActivityGroupResponse,
  CreateActivityGroupRequest,
  UpdateActivityGroupRequest,
  UserGroupResponse,
  CreateUserGroupRequest,
  UpdateUserGroupRequest,
  BudgetResponse,
  CreateBudgetRequest,
  UpdateBudgetRequest,
  LinkResponse,
  UpsertLinkRequest,
  ScheduleResponse,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  ReorderSchedulesRequest,
  ShadowFindingDto,
  ScheduleOrderView,
  GroupScheduleResponse,
  CreateGroupScheduleRequest,
  GroupScheduleOrderView,
  ExceptionResponse,
  CreateExceptionRequest,
  UpdateExceptionRequest,
  AdjustTimeTodayRequest,
  TimeTodayResponse,
  ClientAdjustmentResultDto,
  NotificationPolicyResponse,
  UpsertNotificationPolicyRequest,
} from "../../../../src/api/policy/dtos.js";
export type { AuditEntryResponse, AuditListResponse } from "../../../../src/api/audit/dtos.js";
export type {
  CreateIntegrationTokenRequest,
  IntegrationTokenCreatedResponse,
  IntegrationTokenSummaryResponse,
  IntegrationTokenListResponse,
} from "../../../../src/api/integrations/dtos.js";
export type { IntegrationScope } from "../../../../src/integrations/scopes.js";
export type {
  MintEnrolmentTokenRequest,
  EnrolmentTokenResponse,
} from "../../../../src/api/clients/dtos.js";
export type {
  ClientHealthResponse,
  ComponentHealthDto,
  ClientQueueDto,
  QueuedActionSummary,
} from "../../../../src/api/clients/health-dtos.js";
export type {
  BurndownResponse,
  BudgetBurndownRow,
  TimelineResponse,
  TimelineActivity,
  TimelineSample,
} from "../../../../src/api/usage/dtos.js";
export type {
  ActivityKind,
  MatchType,
  Scope,
  BudgetWindow,
  ScheduleAction,
  SoundProfile,
  AuditOutcome,
} from "../../../../src/policy/enums.js";
export type { ErrorEnvelope, ErrorDetail } from "../../../../src/api/errors.js";
