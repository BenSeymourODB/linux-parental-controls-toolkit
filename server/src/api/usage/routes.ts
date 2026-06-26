/**
 * The usage-views read API (#62):
 *
 * - `GET /api/users/:userId/usage/burndown?window=daily|weekly|monthly`
 * - `GET /api/users/:userId/usage/timeline?from&to`
 *
 * These are the contract the admin burndown chart and per-activity timeline
 * (`docs/architecture.md` → "Key derived views") consume. Like the
 * effective-policy preview (#143, `api/policy/effective.ts`) the handlers stay
 * thin: resolve the user's effective timezone, roll up over the effective-TZ
 * window via the pure `policy/usage.ts` helpers, and serialise. The Svelte
 * components live in the frontend; the API never renders.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { Settings } from "../../config.js";
import { effectiveWindow, resolveEffectiveTz } from "../../policy/budget-window.js";
import * as repo from "../../policy/repository.js";
import { activities, budgets } from "../../policy/schema.js";
import {
  activityTimeline,
  groupSecondsInWindow,
  usageByActivityInWindow,
} from "../../policy/usage.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  burndownQuerySchema,
  timelineQuerySchema,
  usageParamsSchema,
  type BudgetBurndownRow,
  type BurndownResponse,
  type TimelineResponse,
} from "./dtos.js";

/**
 * Register the usage read routes on an already-`/api`-prefixed scope. Call
 * after {@link registerAuth} so `scope.requireAdmin` exists; `settings`
 * supplies the server-default timezone for users with no `tz`.
 */
export function registerUsageRoutes(scope: FastifyInstance, settings: Settings): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/users/:userId/usage/burndown",
    { ...guard, schema: { params: usageParamsSchema, querystring: burndownQuerySchema } },
    async (request): Promise<BurndownResponse> => {
      const { userId } = request.params;
      const user = repo.getUser(scope.db, userId);
      if (user === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }

      const tz = resolveEffectiveTz(user.tz, settings.defaultTz);
      const { window } = request.query;
      const now = new Date();
      const bounds = effectiveWindow(window, now, tz);

      // One pass of per-activity consumption serves both the overall total
      // (Σ over every activity) and each per-activity budget row.
      const byActivity = usageByActivityInWindow(scope.db, { userId, window, now, tz });
      const overallConsumed = [...byActivity.values()].reduce((sum, secs) => sum + secs, 0);

      const budgetRows = scope.db
        .select()
        .from(budgets)
        .where(and(eq(budgets.userId, userId), eq(budgets.window, window)))
        .all();

      const rows: BudgetBurndownRow[] = budgetRows.map((row) => {
        let consumed: number;
        if (row.scope === "activity" && row.targetId !== null) {
          consumed = byActivity.get(row.targetId) ?? 0;
        } else if (row.scope === "group" && row.targetId !== null) {
          consumed = groupSecondsInWindow(scope.db, {
            userId,
            window,
            now,
            tz,
            groupId: row.targetId,
          });
        } else {
          // `overall` (target_id null by the schema CHECK) — total screen time.
          consumed = overallConsumed;
        }
        return {
          scope: row.scope,
          targetId: row.targetId,
          allowedSeconds: row.secondsAllowed,
          consumedSeconds: Math.round(consumed),
        };
      });

      return {
        userId,
        window,
        tz,
        windowStart: bounds.start.toISOString(),
        windowEnd: bounds.end.toISOString(),
        now: now.toISOString(),
        budgets: rows,
      };
    },
  );

  typed.get(
    "/users/:userId/usage/timeline",
    { ...guard, schema: { params: usageParamsSchema, querystring: timelineQuerySchema } },
    async (request): Promise<TimelineResponse> => {
      const { userId } = request.params;
      const user = repo.getUser(scope.db, userId);
      if (user === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }

      const tz = resolveEffectiveTz(user.tz, settings.defaultTz);
      // Default the window to "today" in the user's effective zone; either
      // bound can be overridden independently.
      const defaults = effectiveWindow("daily", new Date(), tz);
      const from = request.query.from !== undefined ? new Date(request.query.from) : defaults.start;
      const to = request.query.to !== undefined ? new Date(request.query.to) : defaults.end;
      if (from.getTime() >= to.getTime()) {
        throw new ApiError(400, "validation_error", "`from` must be before `to`");
      }

      const samples = activityTimeline(scope.db, { userId, from, to });
      const activityIds = [...new Set(samples.map((sample) => sample.activityId))];
      const activityRows =
        activityIds.length > 0
          ? scope.db.select().from(activities).where(inArray(activities.id, activityIds)).all()
          : [];

      return {
        userId,
        tz,
        from: from.toISOString(),
        to: to.toISOString(),
        activities: activityRows.map((activity) => ({
          id: activity.id,
          kind: activity.kind,
          matcher: activity.matcher,
        })),
        samples: samples.map((sample) => ({
          activityId: sample.activityId,
          startedAt: sample.startedAt.toISOString(),
          endedAt: sample.endedAt.toISOString(),
        })),
      };
    },
  );
}
