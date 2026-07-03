/**
 * User-scoped exception routes (#148): `/exceptions`. One-off overrides active
 * over `[effectiveFrom ?? createdAt, expiresAt)`. Every mutation pushes to the
 * owning user's linked clients.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import { userPushCommands, type PolicyPushStub } from "../../../transport/stub.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createExceptionSchema,
  idParamsSchema,
  toExceptionResponse,
  updateExceptionSchema,
  userIdQuerySchema,
  type ExceptionResponse,
} from "../dtos.js";
import {
  assertFound,
  assertTarget,
  asValidated,
  buildExceptionUpdatePatch,
  nullableDate,
} from "./shared.js";

/** Register the `/exceptions` CRUD routes. */
export function registerExceptionRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/exceptions",
    { ...guard, schema: { querystring: userIdQuerySchema } },
    async (request): Promise<ExceptionResponse[]> => {
      const { userId } = request.query;
      const rows =
        userId === undefined
          ? repo.listExceptions(scope.db)
          : repo.listUserExceptions(scope.db, userId);
      return rows.map(toExceptionResponse);
    },
  );

  typed.post(
    "/exceptions",
    { ...guard, schema: { body: createExceptionSchema } },
    async (request, reply): Promise<ExceptionResponse> => {
      const body = request.body;
      assertFound(repo.getUser(scope.db, body.userId), "User", body.userId);
      assertTarget(scope.db, body.targetKind, body.targetId);
      const row = asValidated(
        () =>
          repo.createException(scope.db, {
            userId: body.userId,
            targetKind: body.targetKind,
            targetId: body.targetId,
            action: body.action,
            reason: body.reason,
            effectiveFrom: nullableDate(body.effectiveFrom),
            expiresAt: new Date(body.expiresAt),
          }),
        "The exception violates a target or effective-window constraint",
      );
      push.push(
        userPushCommands(
          "exception.created",
          row.userId,
          repo.listUserClientIds(scope.db, row.userId),
          {
            exceptionId: row.id,
            targetKind: row.targetKind,
            targetId: row.targetId,
            action: row.action,
            expiresAt: row.expiresAt.toISOString(),
          },
        ),
      );
      reply.code(201);
      return toExceptionResponse(row);
    },
  );

  typed.get(
    "/exceptions/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<ExceptionResponse> => {
      const row = assertFound(
        repo.getException(scope.db, request.params.id),
        "Exception",
        request.params.id,
      );
      return toExceptionResponse(row);
    },
  );

  typed.patch(
    "/exceptions/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateExceptionSchema } },
    async (request): Promise<ExceptionResponse> => {
      const existing = assertFound(
        repo.getException(scope.db, request.params.id),
        "Exception",
        request.params.id,
      );
      const body = request.body;
      const nextKind = body.targetKind ?? existing.targetKind;
      const nextTargetId = body.targetId !== undefined ? body.targetId : existing.targetId;
      assertTarget(scope.db, nextKind, nextTargetId);
      const patch = buildExceptionUpdatePatch(body);
      const row = assertFound(
        asValidated(
          () => repo.updateException(scope.db, request.params.id, patch),
          "The exception update violates a target or effective-window constraint",
        ),
        "Exception",
        request.params.id,
      );
      push.push(
        userPushCommands(
          "exception.updated",
          row.userId,
          repo.listUserClientIds(scope.db, row.userId),
          { exceptionId: row.id },
        ),
      );
      return toExceptionResponse(row);
    },
  );

  typed.delete(
    "/exceptions/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const existing = assertFound(
        repo.getException(scope.db, request.params.id),
        "Exception",
        request.params.id,
      );
      const clientIds = repo.listUserClientIds(scope.db, existing.userId);
      repo.deleteException(scope.db, request.params.id);
      push.push(
        userPushCommands("exception.deleted", existing.userId, clientIds, {
          exceptionId: existing.id,
        }),
      );
      return reply.code(204).send();
    },
  );
}
