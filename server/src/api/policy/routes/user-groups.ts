/**
 * User-group routes (#124): `/user-groups` plus the user↔group membership edges
 * (`/user-groups/:groupId/members[/:userId]`, `/users/:userId/groups`). Managing
 * the group set has no direct per-client effect; the group's *rules* (schedules,
 * exceptions, budgets) fan out to members from their own registrars.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createUserGroupSchema,
  groupIdParamsSchema,
  idParamsSchema,
  toUserGroupResponse,
  toUserResponse,
  updateUserGroupSchema,
  userGroupMemberParamsSchema,
  userIdParamsSchema,
  type UserGroupResponse,
  type UserResponse,
} from "../dtos.js";
import { asConflict, assertFound, assertRemoved } from "./shared.js";

/** Register the `/user-groups` CRUD + membership routes. */
export function registerUserGroupRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/user-groups",
    guard,
    async (): Promise<UserGroupResponse[]> =>
      repo.listUserGroups(scope.db).map(toUserGroupResponse),
  );

  typed.post(
    "/user-groups",
    { ...guard, schema: { body: createUserGroupSchema } },
    async (request, reply): Promise<UserGroupResponse> => {
      const row = asConflict(
        () => repo.createUserGroup(scope.db, request.body),
        `A user group named "${request.body.name}" already exists`,
      );
      reply.code(201);
      return toUserGroupResponse(row);
    },
  );

  typed.get(
    "/user-groups/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<UserGroupResponse> => {
      const row = assertFound(
        repo.getUserGroup(scope.db, request.params.id),
        "User group",
        request.params.id,
      );
      return toUserGroupResponse(row);
    },
  );

  typed.patch(
    "/user-groups/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateUserGroupSchema } },
    async (request): Promise<UserGroupResponse> => {
      const row = assertFound(
        asConflict(
          () => repo.updateUserGroup(scope.db, request.params.id, request.body),
          "That user-group name is already in use",
        ),
        "User group",
        request.params.id,
      );
      return toUserGroupResponse(row);
    },
  );

  typed.delete(
    "/user-groups/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      assertRemoved(
        repo.deleteUserGroup(scope.db, request.params.id),
        `User group ${request.params.id} not found`,
      );
      return reply.code(204).send();
    },
  );

  // --- User-group membership (users ↔ user_groups) -------------------------

  typed.get(
    "/user-groups/:groupId/members",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<UserResponse[]> => {
      const { groupId } = request.params;
      assertFound(repo.getUserGroup(scope.db, groupId), "User group", groupId);
      return repo.listGroupMembers(scope.db, groupId).map(toUserResponse);
    },
  );

  typed.get(
    "/users/:userId/groups",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<UserGroupResponse[]> => {
      const { userId } = request.params;
      assertFound(repo.getUser(scope.db, userId), "User", userId);
      return repo.listUserGroupsForUser(scope.db, userId).map(toUserGroupResponse);
    },
  );

  typed.put(
    "/user-groups/:groupId/members/:userId",
    { ...guard, schema: { params: userGroupMemberParamsSchema } },
    async (request, reply) => {
      const { groupId, userId } = request.params;
      // Confirm both ends exist so the caller gets a precise 404 rather than an
      // opaque foreign-key failure.
      assertFound(repo.getUserGroup(scope.db, groupId), "User group", groupId);
      assertFound(repo.getUser(scope.db, userId), "User", userId);
      repo.addUserToGroup(scope.db, groupId, userId);
      return reply.code(204).send();
    },
  );

  typed.delete(
    "/user-groups/:groupId/members/:userId",
    { ...guard, schema: { params: userGroupMemberParamsSchema } },
    async (request, reply) => {
      const { groupId, userId } = request.params;
      assertRemoved(
        repo.removeUserFromGroup(scope.db, groupId, userId),
        `User ${userId} is not a member of group ${groupId}`,
      );
      return reply.code(204).send();
    },
  );
}
