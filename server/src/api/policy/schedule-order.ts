/**
 * Schedule **ordering** endpoints:
 * `GET`/`PUT /api/users/:userId/schedules/order` (#63) and
 * `GET`/`PUT /api/user-groups/:groupId/schedules/order` (#270).
 *
 * The drag-to-reorder editor needs things the plain CRUD routes don't give it:
 * an *atomic* reorder (so a drag-save can never leave duplicate or holey
 * `ordinal`s), the set of rules an earlier rule provably shadows, and — for the
 * user view — the rule in effect *right now* per target. All are derived from
 * the shared precedence module (`policy/schedule-precedence.ts`) and the
 * resolver (`policy/resolve.ts`) — precedence stays server-side, the single
 * source of truth, so the frontend keeps its type-only `/api` boundary and
 * never re-implements the math (ADR 0004).
 *
 * The **user** routes are scoped to a user's own schedules — the unit that
 * editor reorders; inherited group rules (#182) participate in the live
 * effective policy (`GET /users/:userId/effective`) but are not reorderable
 * there. The **group** routes reorder a group's own schedules and omit the "in
 * effect now" fact: a group has no single timezone, so a live instant is only
 * meaningful resolved per member, not for the group (#270).
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
import type { GroupScheduleRow, ScheduleRow } from "../../policy/repository.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  groupIdParamsSchema,
  reorderSchedulesSchema,
  toGroupScheduleOrderView,
  toScheduleOrderView,
  userIdParamsSchema,
  type GroupScheduleOrderView,
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
 * Build the order view for a **group** from its ordered rows: the rules in
 * evaluation order and the conservative shadow findings. Unlike the user view
 * there is no "in effect now" — a group has no single timezone, so a live
 * instant is only meaningful resolved per member (`GET /users/:userId/effective`),
 * not for the group (#270). The shadow heuristic is purely structural, so it
 * carries over unchanged from the shared precedence module.
 */
function buildGroupOrderView(rows: readonly GroupScheduleRow[]): GroupScheduleOrderView {
  return toGroupScheduleOrderView(rows, findShadowedRules(rows));
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

  // --- Group schedule ordering (#270) --------------------------------------
  // The group counterpart of the user routes above: an atomic reorder + the
  // order-view read for a group's own schedules (#182). No timezone is involved
  // — the group view omits "in effect now" (see {@link buildGroupOrderView}).

  typed.get(
    "/user-groups/:groupId/schedules/order",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<GroupScheduleOrderView> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      return buildGroupOrderView(repo.listGroupSchedules(scope.db, groupId));
    },
  );

  typed.put(
    "/user-groups/:groupId/schedules/order",
    { ...guard, schema: { params: groupIdParamsSchema, body: reorderSchedulesSchema } },
    async (request): Promise<GroupScheduleOrderView> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      let rows: GroupScheduleRow[];
      try {
        rows = repo.reorderGroupSchedules(scope.db, groupId, request.body.orderedIds);
      } catch (err) {
        if (err instanceof ReorderMismatchError) {
          // A stale/garbled order (a rule added or deleted since the editor
          // loaded) — reject rather than silently drop or duplicate a position.
          throw new ApiError(409, "conflict", err.message);
        }
        throw err;
      }
      return buildGroupOrderView(rows);
    },
  );
}
