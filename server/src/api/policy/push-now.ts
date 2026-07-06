/**
 * The manual "push saved policy now" admin route (#304):
 * `POST /api/users/:userId/policy-push`.
 *
 * The on-demand companion to the side-effect-free save-and-push preview (#281):
 * re-push a supervised user's **currently saved** effective policy to their
 * linked client(s) and return a per-client `pushed | queued | failed` result.
 * Unlike the CRUD routes' fire-and-forget dispatcher, this **awaits** the
 * transport so the admin sees what actually happened on each client.
 *
 * The live pusher is the injected {@link PolicyPushNow} (the audited
 * `timekpra`-over-SSH executor from the policy-push bootstrap, routed through the
 * offline queue). When it is absent — dev / CI / before first-run SSH keygen
 * (#39) — the route reports the transport as unavailable (503) rather than
 * silently doing nothing, mirroring `POST /users/:userId/time-today`.
 *
 * License boundary: none touched — plain TypeScript + zod over the injected
 * transport, which execs `timekpra` over the SSH subprocess facade.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../policy/repository.js";
import { PushNowTargetError, type PolicyPushNow } from "../../transport/policy-push/index.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import { pushPolicyRequestSchema, userIdParamsSchema, type PushPolicyResponse } from "./dtos.js";

/**
 * Register `POST /api/users/:userId/policy-push` on an already-`/api`-prefixed
 * scope. Call after {@link registerAuth} so `scope.requireAdmin` exists.
 * `pushPolicyNow` is the live transport pusher; omitted, the route returns
 * `503 transport_unavailable`.
 */
export function registerPushNowRoutes(scope: FastifyInstance, pushPolicyNow?: PolicyPushNow): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.post(
    "/users/:userId/policy-push",
    { ...guard, schema: { params: userIdParamsSchema, body: pushPolicyRequestSchema } },
    async (request): Promise<PushPolicyResponse> => {
      const { userId } = request.params;

      // A non-existent user is a 404 — distinct from "exists but has no links"
      // (a 409 below), which the transport's targeting error reports.
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }

      if (pushPolicyNow === undefined) {
        throw new ApiError(
          503,
          "transport_unavailable",
          "Policy push transport is not configured; run first-run SSH keygen (#39) to enable pushes",
        );
      }

      const { clientId } = request.body;

      try {
        const { results } = await pushPolicyNow({
          userId,
          ...(clientId !== undefined ? { clientId } : {}),
        });
        return { userId, results };
      } catch (err) {
        if (err instanceof PushNowTargetError) {
          // A given-but-unlinked client is a 404 (the addressed target doesn't
          // exist for this user); a user with no links at all is a 409 (the
          // request is well-formed but there's nothing to act on).
          throw clientId !== undefined
            ? new ApiError(404, "not_found", err.message)
            : new ApiError(409, "no_linked_clients", err.message);
        }
        throw err;
      }
    },
  );
}
