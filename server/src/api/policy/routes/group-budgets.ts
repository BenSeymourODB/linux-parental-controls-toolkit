/**
 * Group-budget routes (#134): group-targeted baseline allowances (ADR 0008).
 * Nested under the group (the structural owner); a mutation fans the push out
 * to every member's clients, reusing the user-scoped `budget.*` reasons. Item
 * routes are flat by id, like `/budgets/:id`. The resolved per-user baseline
 * (own budget for a slot, else the inherited group budget) is computed in
 * `gatherUserBudgets`.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import type { PolicyPushStub } from "../../../transport/stub.js";
import { ApiError } from "../../errors.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createGroupBudgetSchema,
  groupIdParamsSchema,
  idParamsSchema,
  toGroupBudgetResponse,
  updateBudgetSchema,
  type GroupBudgetResponse,
} from "../dtos.js";
import { assertTarget, asValidated, groupMemberPushCommands } from "./shared.js";

/** Register the group-budget routes. */
export function registerGroupBudgetRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

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
      push.push(
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
      push.push(
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
      push.push(commands);
      return reply.code(204).send();
    },
  );
}
