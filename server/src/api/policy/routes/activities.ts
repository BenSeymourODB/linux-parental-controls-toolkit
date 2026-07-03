/**
 * Activity CRUD routes (#148): `/activities`. Definitions (a matchable
 * app/domain). No push: an activity has no per-client effect until a
 * budget/schedule references it. PATCH re-validates the effective match-type +
 * matcher pair after the merge (ADR 0006).
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import { isValidMatcher } from "../../../policy/activity-matcher.js";
import * as repo from "../../../policy/repository.js";
import { ApiError } from "../../errors.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createActivitySchema,
  idParamsSchema,
  toActivityResponse,
  updateActivitySchema,
  type ActivityResponse,
} from "../dtos.js";
import { assertFound, assertRemoved } from "./shared.js";

/** Register the `/activities` CRUD routes. */
export function registerActivityRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/activities",
    guard,
    async (): Promise<ActivityResponse[]> => repo.listActivities(scope.db).map(toActivityResponse),
  );

  typed.post(
    "/activities",
    { ...guard, schema: { body: createActivitySchema } },
    async (request, reply): Promise<ActivityResponse> => {
      const row = repo.createActivity(scope.db, request.body);
      reply.code(201);
      return toActivityResponse(row);
    },
  );

  typed.get(
    "/activities/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<ActivityResponse> => {
      const row = assertFound(
        repo.getActivity(scope.db, request.params.id),
        "Activity",
        request.params.id,
      );
      return toActivityResponse(row);
    },
  );

  typed.patch(
    "/activities/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateActivitySchema } },
    async (request): Promise<ActivityResponse> => {
      const existing = assertFound(
        repo.getActivity(scope.db, request.params.id),
        "Activity",
        request.params.id,
      );
      // The grammar is a pair (ADR 0006): validate the *effective* match-type +
      // matcher after the patch merges over the stored row, since either field
      // may be the one omitted. createActivitySchema validates this at the DTO
      // layer where both are always present; PATCH needs the merge.
      const matchType = request.body.matchType ?? existing.matchType;
      const matcher = request.body.matcher ?? existing.matcher;
      if (!isValidMatcher(matchType, matcher)) {
        throw new ApiError(400, "validation_error", "matcher is not a valid regular expression");
      }
      const row = assertFound(
        repo.updateActivity(scope.db, request.params.id, request.body),
        "Activity",
        request.params.id,
      );
      return toActivityResponse(row);
    },
  );

  typed.delete(
    "/activities/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      assertRemoved(
        repo.deleteActivity(scope.db, request.params.id),
        `Activity ${request.params.id} not found`,
      );
      return reply.code(204).send();
    },
  );
}
