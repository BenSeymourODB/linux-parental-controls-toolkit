/**
 * Schedule **ordering** endpoints (#63):
 * `GET  /api/users/:userId/schedules/order` and
 * `PUT  /api/users/:userId/schedules/order`.
 *
 * The drag-to-reorder editor needs three things the plain CRUD routes don't
 * give it: an *atomic* reorder (so a drag-save can never leave duplicate or
 * holey `ordinal`s), the set of rules an earlier rule provably shadows, and the
 * rule in effect *right now* per target. All three are derived from the shared
 * precedence module (`policy/schedule-precedence.ts`) and the resolver
 * (`policy/resolve.ts`) — precedence stays server-side, the single source of
 * truth, so the frontend keeps its type-only `/api` boundary and never
 * re-implements the math (ADR 0004).
 *
 * Scoped to a user's **own** schedules — the unit the editor reorders. Inherited
 * group rules (#182) participate in the live effective policy (see
 * `GET /users/:userId/effective`) but are not reorderable here.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import type { Settings } from "../../config.js";
import { resolveEffectiveTz } from "../../policy/budget-window.js";
import * as repo from "../../policy/repository.js";
import { ruleActiveAt } from "../../policy/resolve.js";
import {
  effectiveRuleIds,
  findShadowedRules,
  ReorderMismatchError,
} from "../../policy/schedule-precedence.js";
import type { ScheduleRow } from "../../policy/repository.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  reorderSchedulesSchema,
  toScheduleOrderView,
  userIdParamsSchema,
  type ScheduleOrderView,
} from "./dtos.js";

/**
 * Build the order view for a user from their ordered rows: the rules in
 * evaluation order, the conservative shadow findings, and the ids of the rules
 * in effect right now (resolved in the user's effective timezone). Both derived
 * facts come from the shared precedence module so they stay mutually consistent
 * — a shadowed rule can never also be reported as effective.
 */
function buildOrderView(rows: readonly ScheduleRow[], tz: string): ScheduleOrderView {
  const isActiveNow = ruleActiveAt(new Date(), tz);
  return toScheduleOrderView(rows, findShadowedRules(rows), effectiveRuleIds(rows, isActiveNow));
}

/**
 * Register the schedule-ordering routes on an already-`/api`-prefixed scope.
 * Call after {@link import("../../auth/index.js").registerAuth} so
 * `scope.requireAdmin` is decorated; `settings` supplies the server-default
 * timezone for users with no `tz`.
 */
export function registerScheduleOrderRoutes(scope: FastifyInstance, settings: Settings): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/users/:userId/schedules/order",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<ScheduleOrderView> => {
      const { userId } = request.params;
      const user = repo.getUser(scope.db, userId);
      if (user === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      const rows = repo.listUserSchedules(scope.db, userId);
      return buildOrderView(rows, resolveEffectiveTz(user.tz, settings.defaultTz));
    },
  );

  typed.put(
    "/users/:userId/schedules/order",
    { ...guard, schema: { params: userIdParamsSchema, body: reorderSchedulesSchema } },
    async (request): Promise<ScheduleOrderView> => {
      const { userId } = request.params;
      const user = repo.getUser(scope.db, userId);
      if (user === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      let rows: ScheduleRow[];
      try {
        rows = repo.reorderUserSchedules(scope.db, userId, request.body.orderedIds);
      } catch (err) {
        if (err instanceof ReorderMismatchError) {
          // A stale/garbled order (a rule added or deleted since the editor
          // loaded) — reject rather than silently drop or duplicate a position.
          throw new ApiError(409, "conflict", err.message);
        }
        throw err;
      }
      return buildOrderView(rows, resolveEffectiveTz(user.tz, settings.defaultTz));
    },
  );
}
