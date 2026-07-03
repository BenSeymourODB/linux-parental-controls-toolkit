/**
 * Group-schedule routes (#182): group-targeted recurring rules (ADR 0007). The
 * collection is nested under the group (the structural owner); a mutation fans
 * the push out to every member's clients via {@link groupMemberPushCommands}.
 * Item routes are flat by id, like `/schedules/:id`.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import type { PolicyPushStub } from "../../../transport/stub.js";
import { ApiError } from "../../errors.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createGroupScheduleSchema,
  groupIdParamsSchema,
  idParamsSchema,
  toGroupScheduleResponse,
  updateScheduleSchema,
  type GroupScheduleResponse,
} from "../dtos.js";
import {
  assertTarget,
  asValidated,
  buildScheduleUpdatePatch,
  groupMemberPushCommands,
  nullableDate,
} from "./shared.js";

/** Register the group-schedule routes. */
export function registerGroupScheduleRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/user-groups/:groupId/schedules",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<GroupScheduleResponse[]> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      return repo.listGroupSchedules(scope.db, groupId).map(toGroupScheduleResponse);
    },
  );

  typed.post(
    "/user-groups/:groupId/schedules",
    { ...guard, schema: { params: groupIdParamsSchema, body: createGroupScheduleSchema } },
    async (request, reply): Promise<GroupScheduleResponse> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      const body = request.body;
      assertTarget(scope.db, body.targetKind, body.targetId);
      const row = asValidated(
        () =>
          repo.createGroupSchedule(scope.db, {
            userGroupId: groupId,
            targetKind: body.targetKind,
            targetId: body.targetId,
            action: body.action,
            recurrenceDays: body.recurrenceDays,
            recurrenceStartMinute: body.recurrenceStartMinute,
            recurrenceEndMinute: body.recurrenceEndMinute,
            effectiveFrom: nullableDate(body.effectiveFrom),
            effectiveTo: nullableDate(body.effectiveTo),
            ordinal: body.ordinal,
          }),
        "The group schedule violates a recurrence or target constraint",
      );
      push.push(
        groupMemberPushCommands(scope.db, "schedule.created", groupId, {
          groupScheduleId: row.id,
          userGroupId: groupId,
          targetKind: row.targetKind,
          targetId: row.targetId,
          action: row.action,
          ordinal: row.ordinal,
        }),
      );
      reply.code(201);
      return toGroupScheduleResponse(row);
    },
  );

  typed.get(
    "/group-schedules/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<GroupScheduleResponse> => {
      const row = repo.getGroupSchedule(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Group schedule ${request.params.id} not found`);
      }
      return toGroupScheduleResponse(row);
    },
  );

  typed.patch(
    "/group-schedules/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateScheduleSchema } },
    async (request): Promise<GroupScheduleResponse> => {
      const existing = repo.getGroupSchedule(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Group schedule ${request.params.id} not found`);
      }
      const body = request.body;
      const nextKind = body.targetKind ?? existing.targetKind;
      const nextTargetId = body.targetId !== undefined ? body.targetId : existing.targetId;
      assertTarget(scope.db, nextKind, nextTargetId);
      const patch = buildScheduleUpdatePatch(body);
      const row = asValidated(
        () => repo.updateGroupSchedule(scope.db, request.params.id, patch),
        "The group schedule update violates a recurrence or target constraint",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Group schedule ${request.params.id} not found`);
      }
      push.push(
        groupMemberPushCommands(scope.db, "schedule.updated", row.userGroupId, {
          groupScheduleId: row.id,
          userGroupId: row.userGroupId,
        }),
      );
      return toGroupScheduleResponse(row);
    },
  );

  typed.delete(
    "/group-schedules/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const existing = repo.getGroupSchedule(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Group schedule ${request.params.id} not found`);
      }
      // Build the fan-out from the row's group before the delete (members are
      // unaffected by a rule delete, so order is not strictly required here —
      // kept ahead of the write to mirror the user-DELETE pattern).
      const commands = groupMemberPushCommands(scope.db, "schedule.deleted", existing.userGroupId, {
        groupScheduleId: existing.id,
        userGroupId: existing.userGroupId,
      });
      repo.deleteGroupSchedule(scope.db, request.params.id);
      push.push(commands);
      return reply.code(204).send();
    },
  );
}
