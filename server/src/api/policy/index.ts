/**
 * Policy CRUD surface (#51/#148): the route registrar plus the zod DTOs and
 * inferred types the frontend and integrators consume. Re-exported from the
 * top-level `api/` barrel so the contract is imported from one place.
 */
export { registerPolicyRoutes } from "./routes.js";
export { registerScheduleOrderRoutes } from "./schedule-order.js";
export { registerTimeTodayRoutes } from "./time-today.js";
export {
  registerEffectiveRoutes,
  activeRuleResponseSchema,
  activityQuotaResponseSchema,
  allowedWindowSchema,
  effectivePolicyResponseSchema,
  type EffectivePolicyResponse,
} from "./effective.js";
export { registerPreviewRoutes } from "./preview-routes.js";
export {
  policyPreviewRequestSchema,
  policyPreviewResponseSchema,
  policyPushChangeResponseSchema,
  previewAffectedClientSchema,
  type PolicyPreviewRequest,
  type PolicyPreviewResponse,
  type PreviewAffectedClient,
} from "./preview-dtos.js";
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
  // Schedule ordering / drag-reorder editor (#63)
  reorderSchedulesSchema,
  shadowFindingSchema,
  scheduleOrderViewSchema,
  type ReorderSchedulesRequest,
  type ShadowFindingDto,
  type ScheduleOrderView,
  // Exceptions (#148)
  exceptionResponseSchema,
  createExceptionSchema,
  updateExceptionSchema,
  type ExceptionResponse,
  type CreateExceptionRequest,
  type UpdateExceptionRequest,
  // Notification policy (#104)
  notificationPolicyResponseSchema,
  upsertNotificationPolicySchema,
  type NotificationPolicyResponse,
  type UpsertNotificationPolicyRequest,
  // Group-targeted schedules + exceptions (#182). The PATCH bodies reuse the
  // user-keyed `updateScheduleSchema` / `updateExceptionSchema` above.
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
} from "./dtos.js";
