/**
 * User-scoped budget routes (#148): `/budgets`. Every mutation pushes to the
 * clients the owning user is linked to.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import { userPushCommands, type PolicyPushStub } from "../../../transport/stub.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createBudgetSchema,
  idParamsSchema,
  toBudgetResponse,
  updateBudgetSchema,
  userIdQuerySchema,
  type BudgetResponse,
} from "../dtos.js";
import { assertFound, assertTarget, asValidated } from "./shared.js";

/** Register the `/budgets` CRUD routes. */
export function registerBudgetRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

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
      push.push(
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
      push.push(
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
      push.push(
        userPushCommands("budget.deleted", existing.userId, clientIds, { budgetId: existing.id }),
      );
      return reply.code(204).send();
    },
  );
}
