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
import type { PolicyDb } from "../../policy/db.js";
import type { Scope } from "../../policy/enums.js";
import * as repo from "../../policy/repository.js";
import {
  clientPushCommands,
  createPolicyPushStub,
  linkPushCommands,
  userPushCommands,
  type UserPushReason,
} from "../../transport/stub.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  createActivityGroupSchema,
  createActivitySchema,
  createBudgetSchema,
  createClientSchema,
  createExceptionSchema,
  createGroupExceptionSchema,
  createGroupScheduleSchema,
  createScheduleSchema,
  createUserGroupSchema,
  createUserSchema,
  groupActivityParamsSchema,
  groupIdParamsSchema,
  idParamsSchema,
  toActivityGroupResponse,
  toActivityResponse,
  toBudgetResponse,
  toClientResponse,
  toExceptionResponse,
  toGroupExceptionResponse,
  toGroupScheduleResponse,
  toLinkResponse,
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
  userClientParamsSchema,
  userGroupMemberParamsSchema,
  userIdParamsSchema,
  userIdQuerySchema,
  type ActivityGroupResponse,
  type ActivityResponse,
  type BudgetResponse,
  type ClientResponse,
  type ExceptionResponse,
  type GroupExceptionResponse,
  type GroupScheduleResponse,
  type LinkResponse,
  type ScheduleResponse,
  type UserGroupResponse,
  type UserResponse,
} from "./dtos.js";

/** Run a repository write, mapping a UNIQUE collision to a `409 conflict`. */
function asConflict<T>(write: () => T, message: string): T {
  try {
    return write();
  } catch (err) {
    if (repo.isUniqueViolation(err)) {
      throw new ApiError(409, "conflict", message);
    }
    throw err;
  }
}

/**
 * Run a repository write, mapping a storage `CHECK` violation to a
 * `400 validation_error`. Backstops the merged-row invariants a PATCH can break
 * without the DTO seeing them (budget non-negativity / target coherence,
 * schedule recurrence bounds, the exception effective window) — #148: "map the
 * schema's CHECK constraints to clear 400/409s rather than a generic 500".
 */
function asValidated<T>(write: () => T, message: string): T {
  try {
    return write();
  } catch (err) {
    if (repo.isCheckViolation(err)) {
      throw new ApiError(400, "validation_error", message);
    }
    throw err;
  }
}

/**
 * Enforce the polymorphic-target invariant for a Budget/Schedule/Exception
 * write: a row is `overall` exactly when it has no `target_id`, and an
 * `activity`/`group` target must reference an existing row. Throws a precise
 * `400 validation_error` instead of letting a coherence break hit the storage
 * `CHECK` as an opaque error or a budget dangle against a deleted activity.
 * Shared by create and PATCH so the rule lives in one place.
 */
function assertTarget(db: PolicyDb, kind: Scope, targetId: number | null): void {
  if (kind === "overall") {
    if (targetId !== null) {
      throw new ApiError(
        400,
        "validation_error",
        "targetId must be null when the scope is 'overall'",
      );
    }
    return;
  }
  if (targetId === null) {
    throw new ApiError(400, "validation_error", `targetId is required when the scope is '${kind}'`);
  }
  if (kind === "activity" && repo.getActivity(db, targetId) === undefined) {
    throw new ApiError(400, "validation_error", `Activity ${targetId} not found`);
  }
  if (kind === "group" && repo.getActivityGroup(db, targetId) === undefined) {
    throw new ApiError(400, "validation_error", `Activity group ${targetId} not found`);
  }
}

/**
 * Fan a group-rule mutation out to the push stub: one command per client of
 * every member of the group (#182). A group-targeted schedule/exception affects
 * every member, so it pushes the same way each member's own rule change does —
 * reusing {@link userPushCommands} per member, attributing the push to that
 * member. No new command shape (ADR 0007 §Consequences). A group with no members
 * (or members with no clients) yields an empty list — a no-op push.
 */
function groupMemberPushCommands(
  db: PolicyDb,
  reason: UserPushReason,
  groupId: number,
  detail: Readonly<Record<string, unknown>>,
): ReturnType<typeof userPushCommands> {
  return repo
    .listGroupMembers(db, groupId)
    .flatMap((member) =>
      userPushCommands(reason, member.id, repo.listUserClientIds(db, member.id), detail),
    );
}

/**
 * Register the policy CRUD routes on an already-`/api`-prefixed scope. Call
 * after {@link registerAuth} so `scope.requireAdmin` is decorated.
 */
export function registerPolicyRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  // Phase-2 stub transport (#54): every successful mutation logs the intended
  // per-client effect instead of dispatching it. This is the seam Phase 4
  // (SSH + `timekpra`) and Phase 6 (Ansible) fill in — see `transport/stub.ts`
  // and `docs/architecture.md` → "Outbound (server → client) — policy push".
  const pushStub = createPolicyPushStub(scope.log);

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
      const row = repo.getUser(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `User ${request.params.id} not found`);
      }
      return toUserResponse(row);
    },
  );

  typed.patch(
    "/users/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateUserSchema } },
    async (request): Promise<UserResponse> => {
      const row = repo.updateUser(scope.db, request.params.id, request.body);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `User ${request.params.id} not found`);
      }
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
      if (!repo.deleteUser(scope.db, request.params.id)) {
        throw new ApiError(404, "not_found", `User ${request.params.id} not found`);
      }
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
      const row = repo.getClient(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Client ${request.params.id} not found`);
      }
      return toClientResponse(row);
    },
  );

  typed.patch(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateClientSchema } },
    async (request): Promise<ClientResponse> => {
      const row = asConflict(
        () => repo.updateClient(scope.db, request.params.id, request.body),
        "That hostname is already in use by another client",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Client ${request.params.id} not found`);
      }
      pushStub.push(clientPushCommands("client.updated", row.id, { ...request.body }));
      return toClientResponse(row);
    },
  );

  typed.delete(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!repo.deleteClient(scope.db, request.params.id)) {
        throw new ApiError(404, "not_found", `Client ${request.params.id} not found`);
      }
      pushStub.push(clientPushCommands("client.deleted", request.params.id, {}));
      return reply.code(204).send();
    },
  );

  // --- User-on-client links ------------------------------------------------

  typed.get(
    "/users/:userId/clients",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<LinkResponse[]> => {
      if (repo.getUser(scope.db, request.params.userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${request.params.userId} not found`);
      }
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
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      if (repo.getClient(scope.db, clientId) === undefined) {
        throw new ApiError(404, "not_found", `Client ${clientId} not found`);
      }
      const row = asConflict(
        () => repo.upsertLink(scope.db, userId, clientId, request.body),
        `Linux UID ${request.body.linuxUid} is already mapped to another user on client ${clientId}`,
      );
      pushStub.push(
        linkPushCommands("link.upserted", userId, clientId, {
          linuxUsername: row.linuxUsername,
          linuxUid: row.linuxUid,
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
      if (!repo.deleteLink(scope.db, userId, clientId)) {
        throw new ApiError(
          404,
          "not_found",
          `No link between user ${userId} and client ${clientId}`,
        );
      }
      pushStub.push(linkPushCommands("link.deleted", userId, clientId, {}));
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
      const row = repo.getActivity(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Activity ${request.params.id} not found`);
      }
      return toActivityResponse(row);
    },
  );

  typed.patch(
    "/activities/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateActivitySchema } },
    async (request): Promise<ActivityResponse> => {
      const existing = repo.getActivity(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Activity ${request.params.id} not found`);
      }
      // The grammar is a pair (ADR 0006): validate the *effective* match-type +
      // matcher after the patch merges over the stored row, since either field
      // may be the one omitted. createActivitySchema validates this at the DTO
      // layer where both are always present; PATCH needs the merge.
      const matchType = request.body.matchType ?? existing.matchType;
      const matcher = request.body.matcher ?? existing.matcher;
      if (!isValidMatcher(matchType, matcher)) {
        throw new ApiError(400, "validation_error", "matcher is not a valid regular expression");
      }
      const row = repo.updateActivity(scope.db, request.params.id, request.body);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Activity ${request.params.id} not found`);
      }
      return toActivityResponse(row);
    },
  );

  typed.delete(
    "/activities/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!repo.deleteActivity(scope.db, request.params.id)) {
        throw new ApiError(404, "not_found", `Activity ${request.params.id} not found`);
      }
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
      const row = repo.getActivityGroup(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Activity group ${request.params.id} not found`);
      }
      return toActivityGroupResponse(row);
    },
  );

  typed.patch(
    "/activity-groups/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateActivityGroupSchema } },
    async (request): Promise<ActivityGroupResponse> => {
      const row = asConflict(
        () => repo.updateActivityGroup(scope.db, request.params.id, request.body),
        "That activity-group name is already in use",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Activity group ${request.params.id} not found`);
      }
      return toActivityGroupResponse(row);
    },
  );

  typed.delete(
    "/activity-groups/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!repo.deleteActivityGroup(scope.db, request.params.id)) {
        throw new ApiError(404, "not_found", `Activity group ${request.params.id} not found`);
      }
      return reply.code(204).send();
    },
  );

  // --- Activity-group membership (activities ↔ groups) ---------------------

  typed.get(
    "/activity-groups/:groupId/activities",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<ActivityResponse[]> => {
      const { groupId } = request.params;
      if (repo.getActivityGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `Activity group ${groupId} not found`);
      }
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
      if (repo.getActivityGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `Activity group ${groupId} not found`);
      }
      if (repo.getActivity(scope.db, activityId) === undefined) {
        throw new ApiError(404, "not_found", `Activity ${activityId} not found`);
      }
      repo.addActivityToGroup(scope.db, groupId, activityId);
      return reply.code(204).send();
    },
  );

  typed.delete(
    "/activity-groups/:groupId/activities/:activityId",
    { ...guard, schema: { params: groupActivityParamsSchema } },
    async (request, reply) => {
      const { groupId, activityId } = request.params;
      if (!repo.removeActivityFromGroup(scope.db, groupId, activityId)) {
        throw new ApiError(
          404,
          "not_found",
          `Activity ${activityId} is not a member of group ${groupId}`,
        );
      }
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
      const row = repo.getUserGroup(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `User group ${request.params.id} not found`);
      }
      return toUserGroupResponse(row);
    },
  );

  typed.patch(
    "/user-groups/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateUserGroupSchema } },
    async (request): Promise<UserGroupResponse> => {
      const row = asConflict(
        () => repo.updateUserGroup(scope.db, request.params.id, request.body),
        "That user-group name is already in use",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `User group ${request.params.id} not found`);
      }
      return toUserGroupResponse(row);
    },
  );

  typed.delete(
    "/user-groups/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!repo.deleteUserGroup(scope.db, request.params.id)) {
        throw new ApiError(404, "not_found", `User group ${request.params.id} not found`);
      }
      return reply.code(204).send();
    },
  );

  // --- User-group membership (users ↔ user_groups) -------------------------

  typed.get(
    "/user-groups/:groupId/members",
    { ...guard, schema: { params: groupIdParamsSchema } },
    async (request): Promise<UserResponse[]> => {
      const { groupId } = request.params;
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      return repo.listGroupMembers(scope.db, groupId).map(toUserResponse);
    },
  );

  typed.get(
    "/users/:userId/groups",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<UserGroupResponse[]> => {
      const { userId } = request.params;
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
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
      if (repo.getUserGroup(scope.db, groupId) === undefined) {
        throw new ApiError(404, "not_found", `User group ${groupId} not found`);
      }
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      repo.addUserToGroup(scope.db, groupId, userId);
      return reply.code(204).send();
    },
  );

  typed.delete(
    "/user-groups/:groupId/members/:userId",
    { ...guard, schema: { params: userGroupMemberParamsSchema } },
    async (request, reply) => {
      const { groupId, userId } = request.params;
      if (!repo.removeUserFromGroup(scope.db, groupId, userId)) {
        throw new ApiError(404, "not_found", `User ${userId} is not a member of group ${groupId}`);
      }
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
            effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom),
            effectiveTo: body.effectiveTo === null ? null : new Date(body.effectiveTo),
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
      const patch: repo.GroupScheduleUpdate = {
        ...(body.targetKind !== undefined ? { targetKind: body.targetKind } : {}),
        ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
        ...(body.recurrenceDays !== undefined ? { recurrenceDays: body.recurrenceDays } : {}),
        ...(body.recurrenceStartMinute !== undefined
          ? { recurrenceStartMinute: body.recurrenceStartMinute }
          : {}),
        ...(body.recurrenceEndMinute !== undefined
          ? { recurrenceEndMinute: body.recurrenceEndMinute }
          : {}),
        ...(body.effectiveFrom !== undefined
          ? { effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom) }
          : {}),
        ...(body.effectiveTo !== undefined
          ? { effectiveTo: body.effectiveTo === null ? null : new Date(body.effectiveTo) }
          : {}),
        ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
      };
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
            effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom),
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
      const patch: repo.GroupExceptionUpdate = {
        ...(body.targetKind !== undefined ? { targetKind: body.targetKind } : {}),
        ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.effectiveFrom !== undefined
          ? { effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom) }
          : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
      };
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
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
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
      const row = repo.getBudget(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Budget ${request.params.id} not found`);
      }
      return toBudgetResponse(row);
    },
  );

  typed.patch(
    "/budgets/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateBudgetSchema } },
    async (request): Promise<BudgetResponse> => {
      const existing = repo.getBudget(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Budget ${request.params.id} not found`);
      }
      // Re-validate coherence against the merged row: a PATCH may change only
      // the scope or only the target.
      const nextScope = request.body.scope ?? existing.scope;
      const nextTargetId =
        request.body.targetId !== undefined ? request.body.targetId : existing.targetId;
      assertTarget(scope.db, nextScope, nextTargetId);
      const row = asValidated(
        () => repo.updateBudget(scope.db, request.params.id, request.body),
        "The budget update violates a storage constraint",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Budget ${request.params.id} not found`);
      }
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
      const existing = repo.getBudget(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Budget ${request.params.id} not found`);
      }
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
      if (repo.getUser(scope.db, body.userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${body.userId} not found`);
      }
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
            effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom),
            effectiveTo: body.effectiveTo === null ? null : new Date(body.effectiveTo),
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
      const row = repo.getSchedule(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Schedule ${request.params.id} not found`);
      }
      return toScheduleResponse(row);
    },
  );

  typed.patch(
    "/schedules/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateScheduleSchema } },
    async (request): Promise<ScheduleResponse> => {
      const existing = repo.getSchedule(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Schedule ${request.params.id} not found`);
      }
      const body = request.body;
      const nextKind = body.targetKind ?? existing.targetKind;
      const nextTargetId = body.targetId !== undefined ? body.targetId : existing.targetId;
      assertTarget(scope.db, nextKind, nextTargetId);
      // Translate only the timestamp fields the PATCH actually carries; the
      // merged-row recurrence invariants are backstopped by the storage CHECK.
      const patch: repo.ScheduleUpdate = {
        ...(body.targetKind !== undefined ? { targetKind: body.targetKind } : {}),
        ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
        ...(body.recurrenceDays !== undefined ? { recurrenceDays: body.recurrenceDays } : {}),
        ...(body.recurrenceStartMinute !== undefined
          ? { recurrenceStartMinute: body.recurrenceStartMinute }
          : {}),
        ...(body.recurrenceEndMinute !== undefined
          ? { recurrenceEndMinute: body.recurrenceEndMinute }
          : {}),
        ...(body.effectiveFrom !== undefined
          ? { effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom) }
          : {}),
        ...(body.effectiveTo !== undefined
          ? { effectiveTo: body.effectiveTo === null ? null : new Date(body.effectiveTo) }
          : {}),
        ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
      };
      const row = asValidated(
        () => repo.updateSchedule(scope.db, request.params.id, patch),
        "The schedule update violates a recurrence or target constraint",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Schedule ${request.params.id} not found`);
      }
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
      const existing = repo.getSchedule(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Schedule ${request.params.id} not found`);
      }
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
      if (repo.getUser(scope.db, body.userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${body.userId} not found`);
      }
      assertTarget(scope.db, body.targetKind, body.targetId);
      const row = asValidated(
        () =>
          repo.createException(scope.db, {
            userId: body.userId,
            targetKind: body.targetKind,
            targetId: body.targetId,
            action: body.action,
            reason: body.reason,
            effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom),
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
      const row = repo.getException(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Exception ${request.params.id} not found`);
      }
      return toExceptionResponse(row);
    },
  );

  typed.patch(
    "/exceptions/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateExceptionSchema } },
    async (request): Promise<ExceptionResponse> => {
      const existing = repo.getException(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Exception ${request.params.id} not found`);
      }
      const body = request.body;
      const nextKind = body.targetKind ?? existing.targetKind;
      const nextTargetId = body.targetId !== undefined ? body.targetId : existing.targetId;
      assertTarget(scope.db, nextKind, nextTargetId);
      const patch: repo.ExceptionUpdate = {
        ...(body.targetKind !== undefined ? { targetKind: body.targetKind } : {}),
        ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.effectiveFrom !== undefined
          ? { effectiveFrom: body.effectiveFrom === null ? null : new Date(body.effectiveFrom) }
          : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
      };
      const row = asValidated(
        () => repo.updateException(scope.db, request.params.id, patch),
        "The exception update violates a target or effective-window constraint",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Exception ${request.params.id} not found`);
      }
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
      const existing = repo.getException(scope.db, request.params.id);
      if (existing === undefined) {
        throw new ApiError(404, "not_found", `Exception ${request.params.id} not found`);
      }
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
}
