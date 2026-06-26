/**
 * Per-activity enforcement — the **DB seam** over the pure decision core (#98).
 *
 * Wires the dashboard's policy store to {@link decideEnforcement}: it resolves a
 * user's effective per-activity / per-group quotas for "today" (via the merged
 * `effectivePolicy` engine, #143, which already folds in active grants), rolls
 * up the matching consumption over the same daily window (`policy/usage.ts`),
 * reads the user's grace period, and asks the core which targets to stop.
 *
 * **Daily window only, by design.** `effectivePolicy` emits *daily* per-activity
 * quotas, and consumption is rolled up over the same daily window — the
 * granular per-app quota the architecture's "Enforcement responsibilities" table
 * assigns to dashboard polling. Weekly/monthly budgets are a session-time
 * (Timekpr-nExT) concern, not per-app process-kill, so they are not enforced
 * here.
 *
 * Reads are done inline here rather than through `policy/repository.ts` — the
 * same pattern `api/policy/effective.ts` uses — so this enforcement seam stays
 * decoupled from the CRUD repository surface.
 *
 * The telemetry scheduler (#117) calls this after each rollup and holds the
 * returned cool-down state for the next pass. The decisions it returns are what
 * #99 turns into `enforce.force_close` events (after grace) + the SSH `pkill`
 * fallback; this module emits nothing itself.
 *
 * License boundary: none touched — plain TypeScript + Drizzle reads.
 */
import { eq } from "drizzle-orm";

import type { PolicyDb } from "../policy/db.js";
import { localCalendarDate } from "../policy/budget-window.js";
import { DEFAULT_GRACE_SECONDS } from "../policy/notification.js";
import { effectivePolicy, type BudgetInput, type GrantInput } from "../policy/resolve.js";
import type { ScheduleRule } from "../policy/schedule-precedence.js";
import { budgets, grants, notificationPolicies, schedules } from "../policy/schema.js";
import { groupSecondsInWindow, usageByActivityInWindow } from "../policy/usage.js";

import { decideEnforcement, type EnforcementOutcome } from "./decision.js";

/** Inputs to {@link evaluateUserEnforcement}. */
export interface EvaluateEnforcementInput {
  readonly userId: number;
  /** The rollup's reference instant. */
  readonly now: Date;
  /** The user's effective IANA timezone (`User.tz ?? PCT_DEFAULT_TZ`). */
  readonly tz: string;
  /** Cool-down window passed through to the decision core. */
  readonly cooldownSeconds: number;
}

/**
 * The user's grace period from their notification policy, or the documented
 * default ({@link DEFAULT_GRACE_SECONDS}, the same value the schema column
 * defaults to) when they have no row.
 */
function graceSecondsFor(db: PolicyDb, userId: number): number {
  const row = db
    .select({ graceSeconds: notificationPolicies.graceSeconds })
    .from(notificationPolicies)
    .where(eq(notificationPolicies.userId, userId))
    .get();
  return row?.graceSeconds ?? DEFAULT_GRACE_SECONDS;
}

/**
 * Evaluate per-activity enforcement for one user against the current daily
 * window. Pure aside from read-only DB access; the cool-down state is threaded
 * in via `lastFiredAt` and returned in the outcome.
 */
export function evaluateUserEnforcement(
  db: PolicyDb,
  input: EvaluateEnforcementInput,
  lastFiredAt: ReadonlyMap<string, Date>,
): EnforcementOutcome {
  const { userId, now, tz, cooldownSeconds } = input;

  const scheduleRules: ScheduleRule[] = db
    .select()
    .from(schedules)
    .where(eq(schedules.userId, userId))
    .all();
  const budgetRows: BudgetInput[] = db
    .select()
    .from(budgets)
    .where(eq(budgets.userId, userId))
    .all();
  const grantRows: GrantInput[] = db.select().from(grants).where(eq(grants.userId, userId)).all();

  const effective = effectivePolicy({
    date: localCalendarDate(now, tz),
    tz,
    schedules: scheduleRules,
    budgets: budgetRows,
    grants: grantRows,
  });

  // Per-activity consumption is one scan; per-group consumption is resolved per
  // group target (each expands its own M2M membership — O(group budgets) reads,
  // which is negligible at the household scale this product targets).
  const byActivity = usageByActivityInWindow(db, { userId, window: "daily", now, tz });

  const quotas = effective.perActivitySeconds.map((quota) => {
    const consumedSeconds =
      quota.scope === "activity"
        ? (byActivity.get(quota.targetId) ?? 0)
        : groupSecondsInWindow(db, { userId, window: "daily", now, tz, groupId: quota.targetId });
    return {
      scope: quota.scope,
      targetId: quota.targetId,
      allowedSeconds: quota.seconds,
      consumedSeconds,
    };
  });

  return decideEnforcement({
    now,
    graceSeconds: graceSecondsFor(db, userId),
    cooldownSeconds,
    quotas,
    lastFiredAt,
  });
}
