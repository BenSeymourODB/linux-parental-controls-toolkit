/**
 * The "Add time today" admin route (#257):
 * `POST /api/users/:userId/time-today`.
 *
 * The pre-Grant-ledger bonus / unlock lever (#185): adjust a supervised user's
 * **remaining time for today** on their linked client(s) via `timekpra
 * --settimeleft`, without touching the standing daily `Budget`. Unlike the CRUD
 * routes' fire-and-forget policy push, this **awaits** the transport so the
 * admin gets a per-client applied/unreachable/failed result back.
 *
 * The live adjustment is the injected {@link TimeTodayAdjuster} (the audited
 * `timekpra`-over-SSH service from the policy-push bootstrap). When it is absent
 * — dev / CI / before first-run SSH keygen (#39) — the route reports the
 * transport as unavailable (503) rather than silently doing nothing, mirroring
 * how the CRUD routes degrade to the logging push stub.
 *
 * License boundary: none touched — plain TypeScript + zod over the injected
 * transport, which execs `timekpra` over the SSH subprocess facade.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../policy/repository.js";
import type { TimeTodayAdjuster } from "../../transport/policy-push/index.js";
import { TimeTodayTargetError } from "../../transport/time-today/index.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  adjustTimeTodaySchema,
  toTimeLeftCommand,
  userIdParamsSchema,
  type TimeTodayResponse,
} from "./dtos.js";

/**
 * Register `POST /api/users/:userId/time-today` on an already-`/api`-prefixed
 * scope. Call after {@link registerAuth} so `scope.requireAdmin` exists.
 * `adjustTimeToday` is the live transport adjuster; omitted, the route returns
 * `503 transport_unavailable`.
 */
export function registerTimeTodayRoutes(
  scope: FastifyInstance,
  adjustTimeToday?: TimeTodayAdjuster,
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.post(
    "/users/:userId/time-today",
    { ...guard, schema: { params: userIdParamsSchema, body: adjustTimeTodaySchema } },
    async (request): Promise<TimeTodayResponse> => {
      const { userId } = request.params;

      // A non-existent user is a 404 — distinct from "exists but has no links"
      // (a 409 below), which the transport's targeting error reports.
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }

      if (adjustTimeToday === undefined) {
        throw new ApiError(
          503,
          "transport_unavailable",
          "Policy push transport is not configured; run first-run SSH keygen (#39) to enable same-day time adjustments",
        );
      }

      const { clientId } = request.body;
      const { operation, seconds } = toTimeLeftCommand(request.body);

      try {
        const { results } = await adjustTimeToday({
          userId,
          operation,
          seconds,
          ...(clientId !== undefined ? { clientId } : {}),
        });
        return { userId, operation, seconds, results };
      } catch (err) {
        if (err instanceof TimeTodayTargetError) {
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
