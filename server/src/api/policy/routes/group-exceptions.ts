/**
 * Group-exception routes (#182): group-targeted one-off overrides (ADR 0007);
 * same nesting + push fan-out as group schedules.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import type { PolicyPushStub } from "../../../transport/stub.js";
import { ApiError } from "../../errors.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createGroupExceptionSchema,
  groupIdParamsSchema,
  idParamsSchema,
  toGroupExceptionResponse,
  updateExceptionSchema,
  type GroupExceptionResponse,
} from "../dtos.js";
import {
  assertTarget,
  asValidated,
  buildExceptionUpdatePatch,
  groupMemberPushCommands,
  nullableDate,
} from "./shared.js";

/** Register the group-exception routes. */
export function registerGroupExceptionRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/user-groups/:groupId/exceptions",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<GroupExceptionResponse[]> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      return repo.listGroupExceptions(scope.db, groupId).map(toGroupExceptionResponse);
    },
  );

  typed.post(
    "/user-groups/:groupId/exceptions",
    { ...guard, schema: { params: groupIdParamsSchema, body: createGroupExceptionSchema } },
    async (request, reply): Promise<GroupExceptionResponse> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      const body = request.body;
      assertTarget(scope.db, body.targetKind, body.targetId);
      const row = asValidated(
        () =>
          repo.createGroupException(scope.db, {
            userGroupId: groupId,
            targetKind: body.targetKind,
            targetId: body.targetId,
            action: body.action,
            reason: body.reason,
            effectiveFrom: nullableDate(body.effectiveFrom),
            expiresAt: new Date(body.expiresAt),
          }),
        "The group exception violates a target or effective-window constraint",
      );
      push.push(
        groupMemberPushCommands(scope.db, "exception.created", groupId, {
          groupExceptionId: row.id,
          userGroupId: groupId,
          targetKind: row.targetKind,
          targetId: row.targetId,
          action: row.action,
          expiresAt: row.expiresAt.toISOString(),
        }),
      );
      reply.code(201);
      return toGroupExceptionResponse(row);
    },
  );

  typed.get(
    "/group-exceptions/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<GroupExceptionResponse> => {
      const row = repo.getGroupException(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Group exception ${request.params.id} not found`);
      }
      return toGroupExceptionResponse(row);
    },
  );

  typed.patch(
    "/group-exceptions/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateExceptionSchema } },
    async (request): Promise<GroupExceptionResponse> => {
      const existing = repo.getGroupException(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Group exception ${request.params.id} not found`);
      }
      const body = request.body;
      const nextKind = body.targetKind ?? existing.targetKind;
      const nextTargetId = body.targetId !== undefined ? body.targetId : existing.targetId;
      assertTarget(scope.db, nextKind, nextTargetId);
      const patch = buildExceptionUpdatePatch(body);
      const row = asValidated(
        () => repo.updateGroupException(scope.db, request.params.id, patch),
        "The group exception update violates a target or effective-window constraint",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Group exception ${request.params.id} not found`);
      }
      push.push(
        groupMemberPushCommands(scope.db, "exception.updated", row.userGroupId, {
          groupExceptionId: row.id,
          userGroupId: row.userGroupId,
        }),
      );
      return toGroupExceptionResponse(row);
    },
  );

  typed.delete(
    "/group-exceptions/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const existing = repo.getGroupException(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Group exception ${request.params.id} not found`);
      }
      const commands = groupMemberPushCommands(
        scope.db,
        "exception.deleted",
        existing.userGroupId,
        { groupExceptionId: existing.id, userGroupId: existing.userGroupId },
      );
      repo.deleteGroupException(scope.db, request.params.id);
      push.push(commands);
      return reply.code(204).send();
    },
  );
}
