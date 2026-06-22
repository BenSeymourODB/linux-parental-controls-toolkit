/**
 * Client health/status routes (#81): the read-only `/api/*` surface the admin
 * "Clients" page renders — per-client reachability, component health, and
 * offline + queued-change state.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so both
 * routes inherit the zod validator + shared error envelope and sit behind
 * `requireAdmin` — these reads expose fleet state, so anonymous callers get a
 * `401` envelope, never an unguarded read (`CLAUDE.md` → "no privileged
 * in-process shortcuts").
 *
 * The live SSH {@link ClientProber} is injected via `deps`; until the SSH-key
 * bootstrap (#39) plumbs credentials it is absent, and the service degrades to
 * reporting reachability/components as `unknown` while still surfacing real
 * enrolment + queue state.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify; any remote
 * probing happens inside the injected prober, over the SSH subprocess facade.
 */
import type { FastifyInstance } from "fastify";

import { ApiError } from "../errors.js";
import { idParamsSchema } from "../policy/dtos.js";
import type { ZodTypeProvider } from "../validation.js";
import type { ClientProber } from "../../transport/health/index.js";
import type { ClientHealthResponse } from "./health-dtos.js";
import { getClientHealth, listClientHealth } from "./health-service.js";

/** Dependencies the health routes need from the host app. */
export interface ClientHealthRoutesDeps {
  /**
   * The live SSH prober. Omitted until #39 plumbs SSH credentials; without it
   * the routes report reachability/components as `unknown` (queue + enrolment
   * state is still real).
   */
  prober?: ClientProber;
  /**
   * Max clients probed concurrently in the list walk (#198). Defaults applied
   * by {@link listClientHealth}. Inert until `prober` is wired (#39).
   */
  probeConcurrency?: number;
  /**
   * Per-list probe deadline in ms (#198); `0` disables. Defaults applied by
   * {@link listClientHealth}. Inert until `prober` is wired (#39).
   */
  probeDeadlineMs?: number;
}

/**
 * Register the client health routes on an already-`/api`-prefixed scope. Call
 * after {@link registerAuth} so `scope.requireAdmin` is decorated.
 */
export function registerClientHealthRoutes(
  scope: FastifyInstance,
  deps: ClientHealthRoutesDeps = {},
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/clients/health",
    guard,
    async (): Promise<ClientHealthResponse[]> =>
      listClientHealth(scope.db, deps.prober, {
        concurrency: deps.probeConcurrency,
        deadlineMs: deps.probeDeadlineMs,
      }),
  );

  typed.get(
    "/clients/:id/health",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<ClientHealthResponse> => {
      const health = await getClientHealth(scope.db, request.params.id, deps.prober);
      if (health === undefined) {
        throw new ApiError(404, "not_found", `Client ${request.params.id} not found`);
      }
      return health;
    },
  );
}
