/**
 * The integration-token guard (#114).
 *
 * Mirrors the admin guard (`auth/guard.ts`): `makeRequireIntegrationToken`
 * builds a factory that produces a Fastify `preHandler` gating a route behind a
 * valid, scoped integration bearer token. It is decorated onto the `/api` scope
 * as `app.requireIntegrationToken` so the inbound integration endpoints (the
 * grants endpoint #113, etc.) apply it with
 * `{ preHandler: app.requireIntegrationToken("grants:write") }`.
 *
 * The factory takes the scopes a route requires; the returned handler rejects a
 * missing/invalid/revoked token with `401` and a valid-but-under-scoped token
 * with `403`. On success it records the authenticated integration on
 * `request.integration` for downstream handlers (e.g. to stamp a grant's
 * `source`).
 *
 * License boundary: none touched — plain TypeScript + Fastify.
 */
import type { preHandlerHookHandler } from "fastify";

import { ApiError } from "../api/errors.js";
import { parseBearer } from "../auth/bearer.js";
import type { PolicyDb } from "../policy/db.js";
import type { IntegrationRateLimiter } from "./rate-limit.js";
import { authenticateIntegrationToken, type AuthenticatedIntegration } from "./tokens.js";
import type { IntegrationScope } from "./scopes.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Integration-token guard factory (#114): apply with
     * `{ preHandler: app.requireIntegrationToken("grants:write") }` to gate a
     * route behind a bearer token carrying every listed scope. Decorated by
     * {@link import("../api/integrations/routes.js").registerIntegrationRoutes}.
     */
    requireIntegrationToken: (...scopes: IntegrationScope[]) => preHandlerHookHandler;
  }
  interface FastifyRequest {
    /** The authenticated integration, set by the guard; `null` until then. */
    integration: AuthenticatedIntegration | null;
  }
}

/**
 * Build the integration-token guard factory bound to a policy database. The
 * returned factory takes the scopes a route requires (none = authentication
 * only) and yields the `preHandler` enforcing them.
 *
 * When a {@link IntegrationRateLimiter} is supplied (#115) the guard counts one
 * request against the authenticated **token id** right after authentication and
 * before the scope check — so a noisy integrator is throttled regardless of
 * whether it also has the right scope. Every admitted response carries the
 * `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers; an
 * over-limit request is rejected `429 rate_limited` with a `Retry-After`. Omit
 * the limiter (the default) to disable throttling — the shape existing tests
 * and callers already use.
 */
export function makeRequireIntegrationToken(
  db: PolicyDb,
  rateLimiter?: IntegrationRateLimiter,
): (...scopes: IntegrationScope[]) => preHandlerHookHandler {
  return function requireIntegrationToken(...required: IntegrationScope[]): preHandlerHookHandler {
    return async function integrationGuard(request, reply) {
      const secret = parseBearer(request.headers.authorization);
      if (secret === null) {
        throw new ApiError(
          401,
          "unauthorized",
          "Missing or malformed Authorization: Bearer <integration-token> header",
        );
      }

      const integration = authenticateIntegrationToken(db, secret);
      request.integration = integration;

      // Per-token throttling (#115): count this request and surface the window
      // state. Keyed by the token id so one integrator's burst never starves
      // another's budget. Done after authentication (an unauthenticated request
      // is already `401` and must not consume a token's budget) and before the
      // scope check (a token spamming with the wrong scope is still throttled).
      if (rateLimiter !== undefined) {
        const decision = rateLimiter.consume(String(integration.id));
        reply.header("RateLimit-Limit", decision.limit);
        reply.header("RateLimit-Remaining", decision.remaining);
        reply.header("RateLimit-Reset", decision.resetSeconds);
        if (decision.limited) {
          reply.header("Retry-After", decision.resetSeconds);
          throw new ApiError(
            429,
            "rate_limited",
            `This integration token has exceeded its request rate limit; retry in ${decision.resetSeconds}s`,
          );
        }
      }

      const missing = required.filter((scope) => !integration.scopes.includes(scope));
      if (missing.length > 0) {
        throw new ApiError(
          403,
          "insufficient_scope",
          `This token is missing the required scope(s): ${missing.join(", ")}`,
        );
      }
    };
  };
}
