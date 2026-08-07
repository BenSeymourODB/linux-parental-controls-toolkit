/**
 * The effective-policy **preview** endpoint (#143):
 * `GET /api/users/:userId/effective?date=YYYY-MM-DD`.
 *
 * Resolves "what applies for this user on this day" — today or any future day —
 * via the pure {@link import("../../policy/resolve.js").effectivePolicy} engine,
 * so the admin editor, the `/app` "coming up" surface, and the save-and-push
 * diff all read one answer. The route is the thin DB seam over that resolver:
 * it loads the user's schedules, budgets, and active grants, resolves the date
 * in the user's effective timezone (`User.tz ?? PCT_DEFAULT_TZ`), and maps the
 * result onto the shared `/api/*` envelope.
 *
 * Reads are done inline here rather than through `policy/repository.ts` so this
 * Phase-4 endpoint does not entangle with the in-flight Phase-2 CRUD repository.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Settings } from "../../config.js";
import { resolveEffectiveTz, localCalendarDate } from "../../policy/budget-window.js";
import { scheduleActionSchema, scopeSchema } from "../../policy/enums.js";
import {
  gatherUserBudgets,
  gatherUserExceptions,
  gatherUserScheduleRules,
  type GatheredBudget,
} from "../../policy/group-resolution.js";
import type { ResolvedBudgetResponse } from "./dtos.js";
import * as repo from "../../policy/repository.js";
import { effectivePolicy, type EffectivePolicy, type GrantInput } from "../../policy/resolve.js";
import { grants } from "../../policy/schema.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";

/** Is `(year, month, day)` a real calendar date (so e.g. `2026-02-30` is rejected)? */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * The `?date=` query: an optional `YYYY-MM-DD` calendar date, parsed to its
 * components and rejected (400) if it is not a real date. Absent ⇒ resolve
 * "today" in the user's effective timezone (the handler fills that in, since
 * it depends on the user's `tz`).
 */
const dateQuerySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD form")
  .transform((value, ctx) => {
    // The regex above guarantees three numeric parts; the explicit undefined
    // guard narrows them to `number` without an unchecked `as` tuple cast
    // (CLAUDE.md → "no unchecked `as` casts").
    const [year, month, day] = value.split("-").map(Number);
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      !isRealCalendarDate(year, month, day)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value} is not a real calendar date`,
      });
      return z.NEVER;
    }
    return { year, month, day };
  });

/** `:userId` path param for the effective-policy route. */
const effectiveParamsSchema = z.object({ userId: z.coerce.number().int().positive() });

/** `?date=` querystring for the effective-policy route. */
const effectiveQuerySchema = z.object({ date: dateQuerySchema.optional() });

/** A half-open allowed-access window in local minutes-from-midnight `[start, end)`. */
export const allowedWindowSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
});

/** A schedule rule in play on the resolved day, with its local-minute window. */
export const activeRuleResponseSchema = z.object({
  id: z.number().int(),
  targetKind: scopeSchema,
  targetId: z.number().int().nullable(),
  action: scheduleActionSchema,
  startMinute: z.number().int(),
  endMinute: z.number().int(),
});

/** An effective per-activity / per-group daily quota, in seconds. */
export const activityQuotaResponseSchema = z.object({
  scope: z.enum(["activity", "group"]),
  targetId: z.number().int(),
  seconds: z.number().int(),
});

/** The effective-policy preview response — the resolver's output on the wire. */
export const effectivePolicyResponseSchema = z.object({
  date: z.string(),
  tz: z.string(),
  allowedWindows: z.array(allowedWindowSchema),
  overallSeconds: z.number().int().nullable(),
  perActivitySeconds: z.array(activityQuotaResponseSchema),
  activeRules: z.array(activeRuleResponseSchema),
});

export type EffectivePolicyResponse = z.infer<typeof effectivePolicyResponseSchema>;

/** Copy the resolver's (readonly) result into the mutable wire DTO. */
function toEffectivePolicyResponse(result: EffectivePolicy): EffectivePolicyResponse {
  return {
    date: result.date,
    tz: result.tz,
    allowedWindows: result.allowedWindows.map((w) => ({ start: w.start, end: w.end })),
    overallSeconds: result.overallSeconds,
    perActivitySeconds: result.perActivitySeconds.map((q) => ({
      scope: q.scope,
      targetId: q.targetId,
      seconds: q.seconds,
    })),
    activeRules: result.activeRules.map((r) => ({
      id: r.id,
      targetKind: r.targetKind,
      targetId: r.targetId,
      action: r.action,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
  };
}

/** Copy a gathered budget (readonly, with `source`) into the mutable wire DTO. */
function toResolvedBudgetResponse(budget: GatheredBudget): ResolvedBudgetResponse {
  return {
    scope: budget.scope,
    targetId: budget.targetId,
    window: budget.window,
    secondsAllowed: budget.secondsAllowed,
    source:
      budget.source.kind === "group"
        ? { kind: "group", groupId: budget.source.groupId }
        : { kind: "user" },
  };
}

/**
 * Register `GET /api/users/:userId/effective` (and the sibling
 * `.../budgets/resolved` inherited-vs-local projection) on an already-`/api`-
 * prefixed scope. Call after {@link registerAuth} so `scope.requireAdmin`
 * exists; `settings` supplies the server-default timezone for users with no
 * `tz`.
 */
export function registerEffectiveRoutes(scope: FastifyInstance, settings: Settings): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/users/:userId/effective",
    { ...guard, schema: { params: effectiveParamsSchema, querystring: effectiveQuerySchema } },
    async (request): Promise<EffectivePolicyResponse> => {
      const { userId } = request.params;
      const user = repo.getUser(scope.db, userId);
      if (user === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }

      const tz = resolveEffectiveTz(user.tz, settings.defaultTz);
      // Default to "today" in the user's effective zone when no date is given.
      const date = request.query.date ?? localCalendarDate(new Date(), tz);

      // Own rules first (they win), then inherited group rules, merged and
      // re-sequenced into one precedence-ordered list (#182, ADR 0007).
      const scheduleRules = gatherUserScheduleRules(scope.db, userId);
      // The user's effective budget baseline: own budgets, plus inherited group
      // budgets for any slot the user has not overridden (#134, ADR 0008).
      const budgetRows = gatherUserBudgets(scope.db, userId);
      // Date-specific overrides: own exceptions merged with inherited group
      // exceptions, in precedence order (#142, ADR 0012).
      const exceptionRows = gatherUserExceptions(scope.db, userId);
      const grantRows: GrantInput[] = scope.db
        .select()
        .from(grants)
        .where(eq(grants.userId, userId))
        .all();

      return toEffectivePolicyResponse(
        effectivePolicy({
          date,
          tz,
          schedules: scheduleRules,
          budgets: budgetRows,
          grants: grantRows,
          exceptions: exceptionRows,
        }),
      );
    },
  );

  // Inherited-vs-local budget projection (#363): the user's effective budget
  // baseline per slot with its provenance intact — own budgets plus inherited
  // group budgets for any slot the user has not overridden. Display-only: the
  // resolution (own-wins, lowest-group-id tie-break) lives entirely in
  // `gatherUserBudgets`; this route only serialises it.
  typed.get(
    "/users/:userId/budgets/resolved",
    { ...guard, schema: { params: effectiveParamsSchema } },
    async (request): Promise<ResolvedBudgetResponse[]> => {
      const { userId } = request.params;
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      return gatherUserBudgets(scope.db, userId).map(toResolvedBudgetResponse);
    },
  );
}
