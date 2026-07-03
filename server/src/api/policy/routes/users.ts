/**
 * User CRUD routes (#51): `/users`. Every mutation hands the intended
 * per-client effect to the push stub — a brand-new user pushes to nobody (an
 * empty command list is a no-op), a delete resolves the affected clients before
 * the links cascade away.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import { userPushCommands, type PolicyPushStub } from "../../../transport/stub.js";
import type { ZodTypeProvider } from "../../validation.js";
import { idParamsSchema, toUserResponse, type UserResponse } from "../dtos.js";
import { createUserSchema, updateUserSchema } from "../dtos.js";
import { assertFound, assertRemoved } from "./shared.js";

/** Register the `/users` CRUD routes. */
export function registerUserRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/users",
    guard,
    async (): Promise<UserResponse[]> => repo.listUsers(scope.db).map(toUserResponse),
  );

  typed.post(
    "/users",
    { ...guard, schema: { body: createUserSchema } },
    async (request, reply): Promise<UserResponse> => {
      const row = repo.createUser(scope.db, request.body);
      // A brand-new user has no client links yet, so this pushes to nobody —
      // the seam still fires (an empty command list is a no-op).
      push.push(
        userPushCommands("user.created", row.id, repo.listUserClientIds(scope.db, row.id), {
          displayName: row.displayName,
          tz: row.tz,
        }),
      );
      reply.code(201);
      return toUserResponse(row);
    },
  );

  typed.get(
    "/users/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<UserResponse> => {
      const row = assertFound(repo.getUser(scope.db, request.params.id), "User", request.params.id);
      return toUserResponse(row);
    },
  );

  typed.patch(
    "/users/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateUserSchema } },
    async (request): Promise<UserResponse> => {
      const row = assertFound(
        repo.updateUser(scope.db, request.params.id, request.body),
        "User",
        request.params.id,
      );
      push.push(
        userPushCommands("user.updated", row.id, repo.listUserClientIds(scope.db, row.id), {
          ...request.body,
        }),
      );
      return toUserResponse(row);
    },
  );

  typed.delete(
    "/users/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      // Resolve the affected clients before deleting — the links cascade away
      // with the user.
      const clientIds = repo.listUserClientIds(scope.db, request.params.id);
      assertRemoved(
        repo.deleteUser(scope.db, request.params.id),
        `User ${request.params.id} not found`,
      );
      push.push(userPushCommands("user.deleted", request.params.id, clientIds, {}));
      return reply.code(204).send();
    },
  );
}
