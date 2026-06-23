/**
 * zod DTOs for the usage-views read API (#62), shared with the frontend (the
 * single `/api/*` contract). Two read-only views, both sourced from the
 * `policy/usage.ts` rollups (#88) resolved over the user's effective-timezone
 * budget window (ADR 0001/0003):
 *
 * - **burndown** — per-budget `allowedSeconds` (baseline) vs `consumedSeconds`
 *   for `daily` / `weekly` / `monthly` ("today / week / month").
 * - **timeline** — the raw per-activity intervals over `[from, to)`, plus the
 *   distinct activities they reference, for the per-activity lane labels.
 *
 * There is no write DTO: usage is derived from telemetry, never from a request.
 * All instants serialise as ISO-8601 UTC strings (storage stays UTC epoch
 * seconds); seconds are whole numbers (sample boundaries are second-aligned).
 */
import { z } from "zod";

import { activityKindSchema, budgetWindowSchema, scopeSchema } from "../../policy/enums.js";

/** `:userId` path param shared by both usage routes. */
export const usageParamsSchema = z.object({ userId: z.coerce.number().int().positive() });

/** The inferred, validated `:userId` params. */
export type UsageParams = z.infer<typeof usageParamsSchema>;

/**
 * Querystring for `GET …/usage/burndown`. `window` selects the rollover period
 * to roll up over, defaulting to `daily` ("today").
 */
export const burndownQuerySchema = z.object({
  window: budgetWindowSchema.default("daily"),
});

/** The inferred, validated burndown query. */
export type BurndownQuery = z.infer<typeof burndownQuerySchema>;

/**
 * One budget's burndown: its baseline allowance and how much has been consumed
 * in the window. `targetId` is `null` for the `overall` budget, the activity id
 * for an `activity` budget, and the group id for a `group` budget.
 */
export const budgetBurndownRowSchema = z.object({
  scope: scopeSchema,
  targetId: z.number().int().nullable(),
  /** Baseline budget for the window, in seconds (grant overlay is deferred). */
  allowedSeconds: z.number().int(),
  /** Seconds consumed in the window, clamped to the window's overlap. */
  consumedSeconds: z.number().int(),
});

/** The inferred shape of one budget burndown row. */
export type BudgetBurndownRow = z.infer<typeof budgetBurndownRowSchema>;

/**
 * The burndown response: the effective window bounds (so the renderer can place
 * the "now" marker and ideal-pace line) plus one row per budget the user has in
 * that window.
 */
export const burndownResponseSchema = z.object({
  userId: z.number().int(),
  window: budgetWindowSchema,
  tz: z.string(),
  /** Inclusive window start, ISO-8601 UTC. */
  windowStart: z.string(),
  /** Exclusive window end, ISO-8601 UTC. */
  windowEnd: z.string(),
  /** The reference instant the window was resolved around, ISO-8601 UTC. */
  now: z.string(),
  budgets: z.array(budgetBurndownRowSchema),
});

/** The inferred shape of the burndown response. */
export type BurndownResponse = z.infer<typeof burndownResponseSchema>;

/**
 * Querystring for `GET …/usage/timeline`. Both bounds are optional ISO-8601
 * datetimes; when omitted the handler defaults to the user's `daily` window
 * (today) in their effective timezone. `from` must precede `to` (enforced in
 * the handler, where the defaults are resolved).
 */
export const timelineQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** The inferred, validated timeline query. */
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** An activity referenced by the timeline, for the lane label. */
export const timelineActivitySchema = z.object({
  id: z.number().int(),
  kind: activityKindSchema,
  matcher: z.string(),
});

/** The inferred shape of one timeline activity label. */
export type TimelineActivity = z.infer<typeof timelineActivitySchema>;

/** One usage interval on the timeline. */
export const timelineSampleSchema = z.object({
  activityId: z.number().int(),
  /** Interval start, ISO-8601 UTC. */
  startedAt: z.string(),
  /** Interval end (exclusive), ISO-8601 UTC. */
  endedAt: z.string(),
});

/** The inferred shape of one timeline sample. */
export type TimelineSample = z.infer<typeof timelineSampleSchema>;

/**
 * The timeline response: the resolved `[from, to)` window plus the intervals
 * (ascending by start) and the distinct activities they reference.
 */
export const timelineResponseSchema = z.object({
  userId: z.number().int(),
  tz: z.string(),
  from: z.string(),
  to: z.string(),
  activities: z.array(timelineActivitySchema),
  samples: z.array(timelineSampleSchema),
});

/** The inferred shape of the timeline response. */
export type TimelineResponse = z.infer<typeof timelineResponseSchema>;
