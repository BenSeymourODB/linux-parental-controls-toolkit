/**
 * The PIN-scoped per-child status read (#110, Phase 9):
 * `GET /api/app/status`.
 *
 * The `/app` "My time" screen a supervised user sees after logging in: how much
 * overall time is left today, what they've used, their per-activity limits, and
 * the next schedule transition — all in their effective timezone (ADR 0001);
 * the client renders. **Deny-by-default**, gated by `scope.requirePinSession`
 * and scoped strictly to `request.pinUser.userId` — never a caller-supplied id,
 * exactly like `GET /api/app/me`.
 *
 * The handler stays thin, composing what already exists (mirrors
 * `api/usage/routes.ts` and `api/policy/effective.ts`): the effective-policy
 * resolver for grant-adjusted, weekday-varying quotas + the day's allowed
 * windows, and the `policy/usage.ts` rollups for today's consumption. The
 * next-transition boundary walk lives in the pure `policy/next-transition.ts`.
 *
 * Recent grants ("rewards") are deliberately out of this slice — the Phase-10
 * `Grant` ledger (#113/#116/#117) has no creation path yet; the DTO is shaped
 * so a `rewards` field can be added additively later.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle over the
 * policy store.
 */
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { Settings } from "../../config.js";
import {
  localCalendarDate,
  localDayBounds,
  localTimeOfDayMinutes,
  resolveEffectiveTz,
} from "../../policy/budget-window.js";
import {
  gatherUserBudgets,
  gatherUserExceptions,
  gatherUserScheduleRules,
} from "../../policy/group-resolution.js";
import { isAccessAllowedAt, nextOverallTransition } from "../../policy/next-transition.js";
import { getUser } from "../../policy/repository.js";
import { effectivePolicy, type GrantInput } from "../../policy/resolve.js";
import { activities, activityGroups, grants } from "../../policy/schema.js";
import { groupSecondsInWindow, usageByActivityInWindow } from "../../policy/usage.js";
import { ApiError } from "../errors.js";
import type { AppActivityStatus, AppStatusResponse } from "./dtos.js";

/**
 * Register `GET /api/app/status` on an already-`/api`-prefixed scope. Call after
 * {@link import("../../auth/index.js").registerAuth} so `scope.requirePinSession`
 * is decorated; `settings` supplies the server-default timezone for users with
 * no `tz`.
 */
export function registerAppStatusRoutes(
  scope: FastifyInstance,
  settings: Pick<Settings, "defaultTz">,
): void {
  scope.get(
    "/app/status",
    { preHandler: scope.requirePinSession },
    async (request): Promise<AppStatusResponse> => {
      const pinUser = request.pinUser;
      if (pinUser === null) {
        // Unreachable — the guard sets pinUser or throws — but keeps the
        // handler total without an unchecked assertion (mirrors `/app/me`).
        throw new ApiError(401, "unauthorized", "Authentication required");
      }
      const user = getUser(scope.db, pinUser.userId);
      if (user === undefined) {
        throw new ApiError(401, "unauthorized", "Authentication required");
      }
      const userId = user.id;

      const tz = resolveEffectiveTz(user.tz, settings.defaultTz);
      const now = new Date();
      const todayCal = localCalendarDate(now, tz);
      // Tomorrow's local calendar date: the instant of the *next* local
      // midnight, resolved back to its calendar fields (DST-correct, since
      // `localDayBounds` uses local-midnight wall times).
      const tomorrowCal = localCalendarDate(
        localDayBounds(todayCal.year, todayCal.month, todayCal.day, tz).end,
        tz,
      );

      // The user's full rule set (own + inherited group), loaded once and shared
      // by both the today and tomorrow resolutions (the resolver date-gates).
      const schedules = gatherUserScheduleRules(scope.db, userId);
      const budgets = gatherUserBudgets(scope.db, userId);
      const exceptions = gatherUserExceptions(scope.db, userId);
      const grantRows: GrantInput[] = scope.db
        .select()
        .from(grants)
        .where(eq(grants.userId, userId))
        .all();

      const today = effectivePolicy({
        date: todayCal,
        tz,
        schedules,
        budgets,
        grants: grantRows,
        exceptions,
      });
      const tomorrow = effectivePolicy({
        date: tomorrowCal,
        tz,
        schedules,
        budgets,
        grants: grantRows,
        exceptions,
      });

      // One pass of per-activity consumption over today's effective-TZ window
      // serves both the overall total (Σ) and each per-activity row.
      const byActivity = usageByActivityInWindow(scope.db, {
        userId,
        window: "daily",
        now,
        tz,
      });
      const overallConsumed = Math.round(
        [...byActivity.values()].reduce((sum, secs) => sum + secs, 0),
      );

      // Friendly labels for the "My limits today" rows: an activity's matcher +
      // kind, or a group's name. Loaded in one query per target kind.
      const activityIds = today.perActivitySeconds
        .filter((q) => q.scope === "activity")
        .map((q) => q.targetId);
      const groupIds = today.perActivitySeconds
        .filter((q) => q.scope === "group")
        .map((q) => q.targetId);
      const activityById = new Map(
        (activityIds.length > 0
          ? scope.db.select().from(activities).where(inArray(activities.id, activityIds)).all()
          : []
        ).map((row) => [row.id, row]),
      );
      const groupById = new Map(
        (groupIds.length > 0
          ? scope.db.select().from(activityGroups).where(inArray(activityGroups.id, groupIds)).all()
          : []
        ).map((row) => [row.id, row]),
      );

      const activityRows: AppActivityStatus[] = today.perActivitySeconds.map((quota) => {
        const consumed =
          quota.scope === "activity"
            ? Math.round(byActivity.get(quota.targetId) ?? 0)
            : Math.round(
                groupSecondsInWindow(scope.db, {
                  userId,
                  window: "daily",
                  now,
                  tz,
                  groupId: quota.targetId,
                }),
              );
        const activity = quota.scope === "activity" ? activityById.get(quota.targetId) : undefined;
        const group = quota.scope === "group" ? groupById.get(quota.targetId) : undefined;
        const label = activity?.matcher ?? group?.name ?? `${quota.scope} ${quota.targetId}`;
        return {
          scope: quota.scope,
          targetId: quota.targetId,
          label,
          activityKind: activity?.kind ?? null,
          allowedSeconds: quota.seconds,
          consumedSeconds: consumed,
          remainingSeconds: Math.max(0, quota.seconds - consumed),
        };
      });

      const nowMinute = localTimeOfDayMinutes(now, tz);

      return {
        user: { id: user.id, displayName: user.displayName },
        tz,
        now: now.toISOString(),
        date: today.date,
        overall: {
          allowedSeconds: today.overallSeconds,
          consumedSeconds: overallConsumed,
          remainingSeconds:
            today.overallSeconds === null
              ? null
              : Math.max(0, today.overallSeconds - overallConsumed),
        },
        activities: activityRows,
        access: {
          allowedNow: isAccessAllowedAt(nowMinute, today.allowedWindows),
          nextTransition: nextOverallTransition(
            today.allowedWindows,
            nowMinute,
            today.date,
            tomorrow.allowedWindows,
            tomorrow.date,
          ),
        },
      };
    },
  );
}
