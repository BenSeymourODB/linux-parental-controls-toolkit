/**
 * Activity-group routes (#148): `/activity-groups` plus the activity↔group
 * membership edges (`/activity-groups/:groupId/activities[/:activityId]`). No
 * push: grouping activities has no per-client effect until a budget/schedule
 * references the group.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createActivityGroupSchema,
  groupActivityParamsSchema,
  groupIdParamsSchema,
  idParamsSchema,
  toActivityGroupResponse,
  toActivityResponse,
  updateActivityGroupSchema,
  type ActivityGroupResponse,
  type ActivityResponse,
} from "../dtos.js";
import { asConflict, assertFound, assertRemoved } from "./shared.js";

/** Register the `/activity-groups` CRUD + membership routes. */
export function registerActivityGroupRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/activity-groups",
    guard,
    async (): Promise<ActivityGroupResponse[]> =>
      repo.listActivityGroups(scope.db).map(toActivityGroupResponse),
  );

  typed.post(
    "/activity-groups",
    { ...guard, schema: { body: createActivityGroupSchema } },
    async (request, reply): Promise<ActivityGroupResponse> => {
      const row = asConflict(
        () => repo.createActivityGroup(scope.db, request.body),
        `An activity group named "${request.body.name}" already exists`,
      );
      reply.code(201);
      return toActivityGroupResponse(row);
    },
  );

  typed.get(
    "/activity-groups/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<ActivityGroupResponse> => {
      const row = assertFound(
        repo.getActivityGroup(scope.db, request.params.id),
        "Activity group",
        request.params.id,
      );
      return toActivityGroupResponse(row);
    },
  );

  typed.patch(
    "/activity-groups/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateActivityGroupSchema } },
    async (request): Promise<ActivityGroupResponse> => {
      const row = assertFound(
        asConflict(
          () => repo.updateActivityGroup(scope.db, request.params.id, request.body),
          "That activity-group name is already in use",
        ),
        "Activity group",
        request.params.id,
      );
      return toActivityGroupResponse(row);
    },
  );

  typed.delete(
    "/activity-groups/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      assertRemoved(
        repo.deleteActivityGroup(scope.db, request.params.id),
        `Activity group ${request.params.id} not found`,
      );
      return reply.code(204).send();
    },
  );

  // --- Activity-group membership (activities ↔ groups) ---------------------

  typed.get(
    "/activity-groups/:groupId/activities",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<ActivityResponse[]> => {
      const { groupId } = request.params;
      assertFound(repo.getActivityGroup(scope.db, groupId), "Activity group", groupId);
      return repo.listGroupActivities(scope.db, groupId).map(toActivityResponse);
    },
  );

  typed.put(
    "/activity-groups/:groupId/activities/:activityId",
    { ...guard, schema: { params: groupActivityParamsSchema } },
    async (request, reply) => {
      const { groupId, activityId } = request.params;
      // Confirm both ends exist so the caller gets a precise 404 rather than an
      // opaque foreign-key failure.
      assertFound(repo.getActivityGroup(scope.db, groupId), "Activity group", groupId);
      assertFound(repo.getActivity(scope.db, activityId), "Activity", activityId);
      repo.addActivityToGroup(scope.db, groupId, activityId);
      return reply.code(204).send();
    },
  );

  typed.delete(
    "/activity-groups/:groupId/activities/:activityId",
    { ...guard, schema: { params: groupActivityParamsSchema } },
    async (request, reply) => {
      const { groupId, activityId } = request.params;
      assertRemoved(
        repo.removeActivityFromGroup(scope.db, groupId, activityId),
        `Activity ${activityId} is not a member of group ${groupId}`,
      );
      return reply.code(204).send();
    },
  );
}
