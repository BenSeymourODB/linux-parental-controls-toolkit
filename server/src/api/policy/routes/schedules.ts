/**
 * User-scoped schedule routes (#148): `/schedules`. Recurring rules; timestamps
 * cross the wire as ISO-8601 strings and are stored as epoch-second Dates.
 * Every mutation pushes to the owning user's linked clients.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import { userPushCommands, type PolicyPushStub } from "../../../transport/stub.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createScheduleSchema,
  idParamsSchema,
  toScheduleResponse,
  updateScheduleSchema,
  userIdQuerySchema,
  type ScheduleResponse,
} from "../dtos.js";
import {
  assertFound,
  assertTarget,
  asValidated,
  buildScheduleUpdatePatch,
  nullableDate,
} from "./shared.js";

/** Register the `/schedules` CRUD routes. */
export function registerScheduleRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/schedules",
    { ...guard, schema: { querystring: userIdQuerySchema } },
    async (request): Promise<ScheduleResponse[]> => {
      const { userId } = request.query;
      const rows =
        userId === undefined
          ? repo.listSchedules(scope.db)
          : repo.listUserSchedules(scope.db, userId);
      return rows.map(toScheduleResponse);
    },
  );

  typed.post(
    "/schedules",
    { ...guard, schema: { body: createScheduleSchema } },
    async (request, reply): Promise<ScheduleResponse> => {
      const body = request.body;
      assertFound(repo.getUser(scope.db, body.userId), "User", body.userId);
      assertTarget(scope.db, body.targetKind, body.targetId);
      const row = asValidated(
        () =>
          repo.createSchedule(scope.db, {
            userId: body.userId,
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
        "The schedule violates a recurrence or target constraint",
      );
      push.push(
        userPushCommands(
          "schedule.created",
          row.userId,
          repo.listUserClientIds(scope.db, row.userId),
          {
            scheduleId: row.id,
            targetKind: row.targetKind,
            targetId: row.targetId,
            action: row.action,
            ordinal: row.ordinal,
          },
        ),
      );
      reply.code(201);
      return toScheduleResponse(row);
    },
  );

  typed.get(
    "/schedules/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<ScheduleResponse> => {
      const row = assertFound(
        repo.getSchedule(scope.db, request.params.id),
        "Schedule",
        request.params.id,
      );
      return toScheduleResponse(row);
    },
  );

  typed.patch(
    "/schedules/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateScheduleSchema } },
    async (request): Promise<ScheduleResponse> => {
      const existing = assertFound(
        repo.getSchedule(scope.db, request.params.id),
        "Schedule",
        request.params.id,
      );
      const body = request.body;
      const nextKind = body.targetKind ?? existing.targetKind;
      const nextTargetId = body.targetId !== undefined ? body.targetId : existing.targetId;
      assertTarget(scope.db, nextKind, nextTargetId);
      // Translate only the timestamp fields the PATCH actually carries; the
      // merged-row recurrence invariants are backstopped by the storage CHECK.
      const patch = buildScheduleUpdatePatch(body);
      const row = assertFound(
        asValidated(
          () => repo.updateSchedule(scope.db, request.params.id, patch),
          "The schedule update violates a recurrence or target constraint",
        ),
        "Schedule",
        request.params.id,
      );
      push.push(
        userPushCommands(
          "schedule.updated",
          row.userId,
          repo.listUserClientIds(scope.db, row.userId),
          {
            scheduleId: row.id,
          },
        ),
      );
      return toScheduleResponse(row);
    },
  );

  typed.delete(
    "/schedules/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const existing = assertFound(
        repo.getSchedule(scope.db, request.params.id),
        "Schedule",
        request.params.id,
      );
      const clientIds = repo.listUserClientIds(scope.db, existing.userId);
      repo.deleteSchedule(scope.db, request.params.id);
      push.push(
        userPushCommands("schedule.deleted", existing.userId, clientIds, {
          scheduleId: existing.id,
        }),
      );
      return reply.code(204).send();
    },
  );
}
