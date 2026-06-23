/**
 * Usage-views API surface (#62): the route registrar plus the zod DTOs and
 * inferred types the frontend consumes. Re-exported from the top-level `api/`
 * barrel so the contract is imported from one place.
 */
export { registerUsageRoutes } from "./routes.js";
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
} from "./dtos.js";
