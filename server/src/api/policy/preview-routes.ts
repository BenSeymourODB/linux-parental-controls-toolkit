/**
 * The save-and-push **preview** endpoint (#64, Phase 4):
 * `POST /api/users/:userId/policy-preview`.
 *
 * Before an admin commits a policy edit, this shows exactly what the push would
 * change — and which clients it would reach. It resolves the user's *current*
 * persisted policy and the *proposed* policy in the request body through the one
 * Phase-4 resolver (`transport/policy-push/resolve.ts`), diffs the two resolved
 * pushes (`transport/policy-push/diff.ts`), and lists the user's linked clients
 * annotated with their last-seen time and current offline-queue depth.
 *
 * **Faithful to what is actually pushed.** Current policy is read with
 * `listUserSchedules` + `listUserBudgets` — the user's **own** rules, exactly
 * what the live executor (`transport/policy-push/executor.ts`) resolves and
 * pushes. It deliberately does *not* use the group-merged `gatherUserScheduleRules`
 * that the read-only `effective.ts` preview uses: group schedules are not pushed
 * over `timekpra` yet, so diffing against them would show windows the push never
 * sends.
 *
 * **Side-effect-free.** Preview reads + computes only: no SSH probe, no push, no
 * queue write. The per-client push-vs-queue decision still happens at push time
 * against live reachability (`pushOrEnqueue`); the annotations here are the
 * honest, cheap signals available without touching a client.
 *
 * **Scope.** SSH + `timekpra` session limits (what `resolve.ts` models on
 * `main`). The Ansible-side filter diff (e2guardian / iptables) is Phase 6 (#90)
 * and is a tracked follow-up.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle over the
 * read-only policy/queue seams.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Settings } from "../../config.js";
import { resolveEffectiveTz } from "../../policy/budget-window.js";
import type { PolicyDb } from "../../policy/db.js";
import * as repo from "../../policy/repository.js";
import type { BudgetInput } from "../../policy/resolve.js";
import type { ScheduleRule } from "../../policy/schedule-precedence.js";
import { diffResolvedPush } from "../../transport/policy-push/diff.js";
import { resolvePolicyPush } from "../../transport/policy-push/resolve.js";
import { listForClient } from "../../transport/queue/index.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  policyPreviewRequestSchema,
  type PolicyPreviewRequest,
  type PolicyPreviewResponse,
  type PreviewAffectedClient,
} from "./preview-dtos.js";

/** `:userId` path param for the preview route. */
const previewParamsSchema = z.object({ userId: z.coerce.number().int().positive() });

/** Map a proposed budget DTO onto the resolver's {@link BudgetInput}. */
function toBudgetInput(b: PolicyPreviewRequest["budgets"][number]): BudgetInput {
  return {
    scope: b.scope,
    targetId: b.targetId,
    window: b.window,
    secondsAllowed: b.secondsAllowed,
  };
}

/** Map a proposed schedule DTO onto the resolver's {@link ScheduleRule}. */
function toScheduleRule(s: PolicyPreviewRequest["schedules"][number]): ScheduleRule {
  return {
    id: s.id,
    ordinal: s.ordinal,
    targetKind: s.targetKind,
    targetId: s.targetId,
    action: s.action,
    recurrenceDays: s.recurrenceDays,
    recurrenceStartMinute: s.recurrenceStartMinute,
    recurrenceEndMinute: s.recurrenceEndMinute,
    effectiveFrom: s.effectiveFrom === null ? null : new Date(s.effectiveFrom),
    effectiveTo: s.effectiveTo === null ? null : new Date(s.effectiveTo),
  };
}

/**
 * The clients the user's push fans out to, each annotated with the
 * side-effect-free signals preview can offer (last seen + pending-queue depth).
 * Ascending by client id for a stable render.
 */
function affectedClientsForUser(db: PolicyDb, userId: number): PreviewAffectedClient[] {
  const result: PreviewAffectedClient[] = [];
  for (const link of repo.listUserLinks(db, userId)) {
    const client = repo.getClient(db, link.clientId);
    if (client === undefined) continue;
    const pendingQueueDepth = listForClient(db, client.id).filter(
      (row) => row.status === "pending",
    ).length;
    result.push({
      clientId: client.id,
      hostname: client.hostname,
      lastSeen: client.lastSeen === null ? null : client.lastSeen.toISOString(),
      pendingQueueDepth,
    });
  }
  return result.sort((a, b) => a.clientId - b.clientId);
}

/**
 * Register `POST /api/users/:userId/policy-preview` on an already-`/api`-prefixed
 * scope. Call after {@link registerAuth} so `scope.requireAdmin` exists;
 * `settings` supplies the server-default timezone for users with no `tz`.
 */
export function registerPreviewRoutes(scope: FastifyInstance, settings: Settings): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.post(
    "/users/:userId/policy-preview",
    { ...guard, schema: { params: previewParamsSchema, body: policyPreviewRequestSchema } },
    async (request): Promise<PolicyPreviewResponse> => {
      const { userId } = request.params;
      const user = repo.getUser(scope.db, userId);
      if (user === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }

      const tz = resolveEffectiveTz(user.tz, settings.defaultTz);
      const now = request.body.now === undefined ? new Date() : new Date(request.body.now);

      // Current policy mirrors the live executor: the user's OWN schedules +
      // budgets (group schedules are not pushed over timekpra yet), resolved at
      // the same reference instant.
      const before = resolvePolicyPush({
        tz,
        schedules: repo.listUserSchedules(scope.db, userId),
        budgets: repo.listUserBudgets(scope.db, userId),
        now,
      });
      const after = resolvePolicyPush({
        tz,
        schedules: request.body.schedules.map(toScheduleRule),
        budgets: request.body.budgets.map(toBudgetInput),
        now,
      });

      const diff = diffResolvedPush(before, after);

      return {
        userId,
        hasChanges: diff.hasChanges,
        changes: diff.changes.map((c) => ({
          field: c.field,
          kind: c.kind,
          weekday: c.weekday,
          before: c.before,
          after: c.after,
          summary: c.summary,
        })),
        affectedClients: affectedClientsForUser(scope.db, userId),
      };
    },
  );
}
