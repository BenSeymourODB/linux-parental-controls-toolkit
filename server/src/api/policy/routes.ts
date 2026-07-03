/**
 * Policy CRUD routes for the account/device core (#51): `User`, `Client`, and
 * the `UserOnClient` link.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so every
 * route inherits the zod validator compiler + shared error envelope and sits
 * behind the `requireAdmin` guard — anonymous requests get a `401` envelope,
 * never an unguarded read/write (`CLAUDE.md` → "no privileged in-process
 * shortcuts"). Handlers stay thin: they validate via the DTOs, delegate to the
 * `policy/repository` service over `app.db`, and map "missing row" → `404` and
 * unique-constraint collisions → `409`.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import { isValidMatcher } from "../../policy/activity-matcher.js";
import * as repo from "../../policy/repository.js";
import {
  clientPushCommands,
  createPolicyPushStub,
  linkPushCommands,
  userPushCommands,
  type PolicyPushStub,
} from "../../transport/stub.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  asConflict,
  assertFound,
  assertRemoved,
  assertTarget,
  asValidated,
  buildExceptionUpdatePatch,
  buildScheduleUpdatePatch,
  groupMemberPushCommands,
  notFound,
  nullableDate,
} from "./routes/shared.js";
import {
  createActivityGroupSchema,
  createActivitySchema,
  createBudgetSchema,
  createClientSchema,
  createExceptionSchema,
  createGroupBudgetSchema,
  createGroupExceptionSchema,
  createGroupScheduleSchema,
  createScheduleSchema,
  createUserGroupSchema,
  createUserSchema,
  defaultNotificationPolicyResponse,
  groupActivityParamsSchema,
  groupIdParamsSchema,
  idParamsSchema,
  toActivityGroupResponse,
  toActivityResponse,
  toBudgetResponse,
  toClientResponse,
  toExceptionResponse,
  toGroupBudgetResponse,
  toGroupExceptionResponse,
  toGroupScheduleResponse,
  toLinkResponse,
  toNotificationPolicyResponse,
  toScheduleResponse,
  toUserGroupResponse,
  toUserResponse,
  updateActivityGroupSchema,
  updateActivitySchema,
  updateBudgetSchema,
  updateClientSchema,
  updateExceptionSchema,
  updateScheduleSchema,
  updateUserGroupSchema,
  updateUserSchema,
  upsertLinkSchema,
  upsertNotificationPolicySchema,
  userClientParamsSchema,
  userGroupMemberParamsSchema,
  userIdParamsSchema,
  userIdQuerySchema,
  type ActivityGroupResponse,
  type ActivityResponse,
  type BudgetResponse,
  type ClientResponse,
  type ExceptionResponse,
  type GroupBudgetResponse,
  type GroupExceptionResponse,
  type GroupScheduleResponse,
  type LinkResponse,
  type NotificationPolicyResponse,
  type ScheduleResponse,
  type UserGroupResponse,
  type UserResponse,
} from "./dtos.js";

// The 404 helpers keep their historical `./routes.js` import path (a test and
// potential integrators import them from here) even though they now live in the
// shared registrar module.
export { assertFound, assertRemoved, notFound } from "./routes/shared.js";

/**
 * Register the policy CRUD routes on an already-`/api`-prefixed scope. Call
 * after {@link registerAuth} so `scope.requireAdmin` is decorated.
 *
 * Every successful mutation hands the intended per-client effect to `push`. In
 * production that is the live `timekpra`-over-SSH dispatcher (#201, wired in
 * `buildApp`), which pushes to reachable clients and queues for offline ones
 * (#84) — see `transport/policy-push/` and `docs/architecture.md` → "Outbound
 * (server → client) — policy push". When no dispatcher is injected (no SSH key
 * yet, #39; or a test), it defaults to the logging stub (#54), so CRUD still
 * works and the change is logged rather than dispatched.
 */
export function registerPolicyRoutes(scope: FastifyInstance, push?: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  const pushStub = push ?? createPolicyPushStub(scope.log);

  // --- Users ---------------------------------------------------------------

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
      pushStub.push(
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
      pushStub.push(
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
      pushStub.push(userPushCommands("user.deleted", request.params.id, clientIds, {}));
      return reply.code(204).send();
    },
  );

  // --- Clients -------------------------------------------------------------

  typed.get(
    "/clients",
    guard,
    async (): Promise<ClientResponse[]> => repo.listClients(scope.db).map(toClientResponse),
  );

  typed.post(
    "/clients",
    { ...guard, schema: { body: createClientSchema } },
    async (request, reply): Promise<ClientResponse> => {
      const row = asConflict(
        () => repo.createClient(scope.db, request.body),
        `A client with hostname "${request.body.hostname}" already exists`,
      );
      pushStub.push(
        clientPushCommands("client.created", row.id, {
          hostname: row.hostname,
          sshUser: row.sshUser,
        }),
      );
      reply.code(201);
      return toClientResponse(row);
    },
  );

  typed.get(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<ClientResponse> => {
      const row = assertFound(
        repo.getClient(scope.db, request.params.id),
        "Client",
        request.params.id,
      );
      return toClientResponse(row);
    },
  );

  typed.patch(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateClientSchema } },
    async (request): Promise<ClientResponse> => {
      const row = assertFound(
        asConflict(
          () => repo.updateClient(scope.db, request.params.id, request.body),
          "That hostname is already in use by another client",
        ),
        "Client",
        request.params.id,
      );
      pushStub.push(clientPushCommands("client.updated", row.id, { ...request.body }));
      return toClientResponse(row);
    },
  );

  typed.delete(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      assertRemoved(
        repo.deleteClient(scope.db, request.params.id),
        `Client ${request.params.id} not found`,
      );
      pushStub.push(clientPushCommands("client.deleted", request.params.id, {}));
      return reply.code(204).send();
    },
  );

  // --- User-on-client links ------------------------------------------------

  typed.get(
    "/users/:userId/clients",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<LinkResponse[]> => {
      assertFound(repo.getUser(scope.db, request.params.userId), "User", request.params.userId);
      return repo.listUserLinks(scope.db, request.params.userId).map(toLinkResponse);
    },
  );

  typed.put(
    "/users/:userId/clients/:clientId",
    { ...guard, schema: { params: userClientParamsSchema, body: upsertLinkSchema } },
    async (request): Promise<LinkResponse> => {
      const { userId, clientId } = request.params;
      // Confirm both ends exist so the caller gets a precise 404 rather than an
      // opaque foreign-key failure.
      assertFound(repo.getUser(scope.db, userId), "User", userId);
      assertFound(repo.getClient(scope.db, clientId), "Client", clientId);
      const row = asConflict(
        () => repo.upsertLink(scope.db, userId, clientId, request.body),
        `OS account reference ${request.body.osUserRef} is already mapped to another user on client ${clientId}`,
      );
      pushStub.push(
        linkPushCommands("link.upserted", userId, clientId, {
          osUsername: row.osUsername,
          osUserRef: row.osUserRef,
        }),
      );
      return toLinkResponse(row);
    },
  );

  typed.delete(
    "/users/:userId/clients/:clientId",
    { ...guard, schema: { params: userClientParamsSchema } },
    async (request, reply) => {
      const { userId, clientId } = request.params;
      const removed = repo.deleteLink(scope.db, userId, clientId);
      if (removed === undefined) {
        throw notFound(`No link between user ${userId} and client ${clientId}`);
      }
      // Carry the now-cascaded-away OS account name so the executor can
      // "unmanage" it on the client (lift stale timekpra limits back to
      // unrestricted), #253 — the link row is gone, so the name can only come
      // from here. Mirrors the `link.upserted` detail.
      pushStub.push(
        linkPushCommands("link.deleted", userId, clientId, {
          osUsername: removed.osUsername,
          osUserRef: removed.osUserRef,
        }),
      );
      return reply.code(204).send();
    },
  );

  // --- Activities ----------------------------------------------------------
  // Definitions (a matchable app/domain). No push: an activity has no
  // per-client effect until a budget/schedule references it.

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

  // --- Activity groups -----------------------------------------------------

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

  // --- User groups (#124) --------------------------------------------------

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

  // --- Group schedules (#182) ----------------------------------------------
  // Group-targeted recurring rules (ADR 0007). The collection is nested under
  // the group (the group is the structural owner); a mutation fans the push out
  // to every member's clients. Item routes are flat by id, like `/schedules/:id`.

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
      pushStub.push(
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
      pushStub.push(
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
      pushStub.push(commands);
      return reply.code(204).send();
    },
  );

  // --- Group exceptions (#182) ---------------------------------------------
  // Group-targeted one-off overrides (ADR 0007); same nesting + fan-out as
  // group schedules.

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
      pushStub.push(
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
      pushStub.push(
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
      pushStub.push(commands);
      return reply.code(204).send();
    },
  );

  // --- Group budgets (#134) ------------------------------------------------
  // Group-targeted baseline allowances (ADR 0008). Nested under the group (the
  // structural owner); a mutation fans the push out to every member's clients,
  // reusing the user-scoped `budget.*` reasons. Item routes are flat by id,
  // like `/budgets/:id`. The resolved per-user baseline (own budget for a slot,
  // else the inherited group budget) is computed in `gatherUserBudgets`.

  typed.get(
    "/user-groups/:groupId/budgets",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<GroupBudgetResponse[]> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      return repo.listGroupBudgets(scope.db, groupId).map(toGroupBudgetResponse);
    },
  );

  typed.post(
    "/user-groups/:groupId/budgets",
    { ...guard, schema: { params: groupIdParamsSchema, body: createGroupBudgetSchema } },
    async (request, reply): Promise<GroupBudgetResponse> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      const { scope: budgetScope, targetId } = request.body;
      assertTarget(scope.db, budgetScope, targetId);
      const row = asValidated(
        () => repo.createGroupBudget(scope.db, { userGroupId: groupId, ...request.body }),
        "The group budget violates a storage constraint (target coherence or a negative allowance)",
      );
      pushStub.push(
        groupMemberPushCommands(scope.db, "budget.created", groupId, {
          groupBudgetId: row.id,
          userGroupId: groupId,
          scope: row.scope,
          targetId: row.targetId,
          window: row.window,
          secondsAllowed: row.secondsAllowed,
        }),
      );
      reply.code(201);
      return toGroupBudgetResponse(row);
    },
  );

  typed.get(
    "/group-budgets/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<GroupBudgetResponse> => {
      const row = repo.getGroupBudget(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Group budget ${request.params.id} not found`);
      }
      return toGroupBudgetResponse(row);
    },
  );

  typed.patch(
    "/group-budgets/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateBudgetSchema } },
    async (request): Promise<GroupBudgetResponse> => {
      const existing = repo.getGroupBudget(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Group budget ${request.params.id} not found`);
      }
      // Re-validate coherence against the merged row: a PATCH may change only
      // the scope or only the target.
      const nextScope = request.body.scope ?? existing.scope;
      const nextTargetId =
        request.body.targetId !== undefined ? request.body.targetId : existing.targetId;
      assertTarget(scope.db, nextScope, nextTargetId);
      const row = asValidated(
        () => repo.updateGroupBudget(scope.db, request.params.id, request.body),
        "The group budget update violates a storage constraint",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Group budget ${request.params.id} not found`);
      }
      pushStub.push(
        groupMemberPushCommands(scope.db, "budget.updated", row.userGroupId, {
          groupBudgetId: row.id,
          userGroupId: row.userGroupId,
          ...request.body,
        }),
      );
      return toGroupBudgetResponse(row);
    },
  );

  typed.delete(
    "/group-budgets/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const existing = repo.getGroupBudget(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Group budget ${request.params.id} not found`);
      }
      // Resolve the fan-out from the row's group before the delete.
      const commands = groupMemberPushCommands(scope.db, "budget.deleted", existing.userGroupId, {
        groupBudgetId: existing.id,
        userGroupId: existing.userGroupId,
      });
      repo.deleteGroupBudget(scope.db, request.params.id);
      pushStub.push(commands);
      return reply.code(204).send();
    },
  );

  // --- Budgets -------------------------------------------------------------
  // User-scoped: every mutation pushes to the clients that user is linked to.

  typed.get(
    "/budgets",
    { ...guard, schema: { querystring: userIdQuerySchema } },
    async (request): Promise<BudgetResponse[]> => {
      const { userId } = request.query;
      const rows =
        userId === undefined ? repo.listBudgets(scope.db) : repo.listUserBudgets(scope.db, userId);
      return rows.map(toBudgetResponse);
    },
  );

  typed.post(
    "/budgets",
    { ...guard, schema: { body: createBudgetSchema } },
    async (request, reply): Promise<BudgetResponse> => {
      const { userId, scope: budgetScope, targetId } = request.body;
      assertFound(repo.getUser(scope.db, userId), "User", userId);
      assertTarget(scope.db, budgetScope, targetId);
      const row = asValidated(
        () => repo.createBudget(scope.db, request.body),
        "The budget violates a storage constraint (target coherence or a negative allowance)",
      );
      pushStub.push(
        userPushCommands("budget.created", userId, repo.listUserClientIds(scope.db, userId), {
          budgetId: row.id,
          scope: row.scope,
          targetId: row.targetId,
          window: row.window,
          secondsAllowed: row.secondsAllowed,
        }),
      );
      reply.code(201);
      return toBudgetResponse(row);
    },
  );

  typed.get(
    "/budgets/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<BudgetResponse> => {
      const row = assertFound(
        repo.getBudget(scope.db, request.params.id),
        "Budget",
        request.params.id,
      );
      return toBudgetResponse(row);
    },
  );

  typed.patch(
    "/budgets/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateBudgetSchema } },
    async (request): Promise<BudgetResponse> => {
      const existing = assertFound(
        repo.getBudget(scope.db, request.params.id),
        "Budget",
        request.params.id,
      );
      // Re-validate coherence against the merged row: a PATCH may change only
      // the scope or only the target.
      const nextScope = request.body.scope ?? existing.scope;
      const nextTargetId =
        request.body.targetId !== undefined ? request.body.targetId : existing.targetId;
      assertTarget(scope.db, nextScope, nextTargetId);
      const row = assertFound(
        asValidated(
          () => repo.updateBudget(scope.db, request.params.id, request.body),
          "The budget update violates a storage constraint",
        ),
        "Budget",
        request.params.id,
      );
      pushStub.push(
        userPushCommands(
          "budget.updated",
          row.userId,
          repo.listUserClientIds(scope.db, row.userId),
          {
            budgetId: row.id,
            ...request.body,
          },
        ),
      );
      return toBudgetResponse(row);
    },
  );

  typed.delete(
    "/budgets/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      // Resolve the owner (and their clients) before deleting so the push can
      // still fan out to the right clients.
      const existing = assertFound(
        repo.getBudget(scope.db, request.params.id),
        "Budget",
        request.params.id,
      );
      const clientIds = repo.listUserClientIds(scope.db, existing.userId);
      repo.deleteBudget(scope.db, request.params.id);
      pushStub.push(
        userPushCommands("budget.deleted", existing.userId, clientIds, { budgetId: existing.id }),
      );
      return reply.code(204).send();
    },
  );

  // --- Schedules -----------------------------------------------------------
  // User-scoped recurring rules. Timestamps cross the wire as ISO-8601 strings
  // and are stored as epoch-second Dates.

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
      pushStub.push(
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
      pushStub.push(
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
      pushStub.push(
        userPushCommands("schedule.deleted", existing.userId, clientIds, {
          scheduleId: existing.id,
        }),
      );
      return reply.code(204).send();
    },
  );

  // --- Exceptions ----------------------------------------------------------
  // User-scoped one-off overrides active over `[effectiveFrom ?? createdAt,
  // expiresAt)`.

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
      pushStub.push(
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
      pushStub.push(
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
      pushStub.push(
        userPushCommands("exception.deleted", existing.userId, clientIds, {
          exceptionId: existing.id,
        }),
      );
      return reply.code(204).send();
    },
  );

  // --- Notification policy (#104) ------------------------------------------
  // Per-user (1:1), pushed to the client "with the rest of policy" and cached
  // there (docs/client-notifications.md). A user always *has* an effective
  // policy: GET returns the persisted row or the documented defaults; PUT
  // upserts; DELETE reverts to defaults. Mutations fan out to the user's
  // linked clients exactly like budget.*/schedule.* (eventual wire delivery is
  // the `policy.changed` event, #100).

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
      pushStub.push(
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
      pushStub.push(userPushCommands("notification.deleted", userId, clientIds, {}));
      return reply.code(204).send();
    },
  );
}
