/**
 * Per-user notification-policy routes (#104):
 * `/users/:userId/notification-policy`. Pushed to the client "with the rest of
 * policy" and cached there (docs/client-notifications.md). A user always *has*
 * an effective policy: GET returns the persisted row or the documented
 * defaults; PUT upserts; DELETE reverts to defaults. Mutations fan out to the
 * user's linked clients exactly like the `budget.*` / `schedule.*` reasons
 * (eventual wire delivery is the `policy.changed` event, #100).
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import { userPushCommands, type PolicyPushStub } from "../../../transport/stub.js";
import { ApiError } from "../../errors.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  defaultNotificationPolicyResponse,
  toNotificationPolicyResponse,
  upsertNotificationPolicySchema,
  userIdParamsSchema,
  type NotificationPolicyResponse,
} from "../dtos.js";
import { asValidated } from "./shared.js";

/** Register the notification-policy routes. */
export function registerNotificationPolicyRoutes(
  scope: FastifyInstance,
  push: PolicyPushStub,
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/users/:userId/notification-policy",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<NotificationPolicyResponse> => {
      const { userId } = request.params;
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      const row = repo.getNotificationPolicy(scope.db, userId);
      return row === undefined
        ? defaultNotificationPolicyResponse(userId)
        : toNotificationPolicyResponse(row);
    },
  );

  typed.put(
    "/users/:userId/notification-policy",
    { ...guard, schema: { params: userIdParamsSchema, body: upsertNotificationPolicySchema } },
    async (request): Promise<NotificationPolicyResponse> => {
      const { userId } = request.params;
      // Confirm the user exists so the caller gets a precise 404 rather than an
      // opaque foreign-key failure.
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      const row = asValidated(
        () => repo.upsertNotificationPolicy(scope.db, userId, request.body),
        "The notification policy violates a storage constraint",
      );
      push.push(
        userPushCommands(
          "notification.upserted",
          userId,
          repo.listUserClientIds(scope.db, userId),
          {
            enabled: row.enabled,
            soundProfile: row.soundProfile,
            graceSeconds: row.graceSeconds,
            // The full effective policy is pushed "with the rest of policy" and
            // cached client-side (#100/#103), so carry the cadence overrides the
            // upsert just persisted — `null` means the built-in cadence.
            cadenceOverrides: row.cadenceOverridesJson ?? null,
          },
        ),
      );
      return toNotificationPolicyResponse(row);
    },
  );

  typed.delete(
    "/users/:userId/notification-policy",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request, reply) => {
      const { userId } = request.params;
      // Resolve the affected clients before deleting so the push still fans out.
      const clientIds = repo.listUserClientIds(scope.db, userId);
      if (!repo.deleteNotificationPolicy(scope.db, userId)) {
        // No persisted row: either the user doesn't exist or they were already
        // at defaults. Distinguish so "already default" isn't a silent 204 lie.
        if (repo.getUser(scope.db, userId) === undefined) {
          throw new ApiError(404, "not_found", `User ${userId} not found`);
        }
        throw new ApiError(
          404,
          "not_found",
          `User ${userId} has no custom notification policy (already at defaults)`,
        );
      }
      push.push(userPushCommands("notification.deleted", userId, clientIds, {}));
      return reply.code(204).send();
    },
  );
}
