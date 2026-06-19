/**
 * Policy CRUD surface (#51/#148): the route registrar plus the zod DTOs and
 * inferred types the frontend and integrators consume. Re-exported from the
 * top-level `api/` barrel so the contract is imported from one place.
 */
export { registerPolicyRoutes } from "./routes.js";
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
} from "./dtos.js";
