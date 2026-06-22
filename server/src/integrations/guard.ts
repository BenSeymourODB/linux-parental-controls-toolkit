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
 */
export function makeRequireIntegrationToken(
  db: PolicyDb,
): (...scopes: IntegrationScope[]) => preHandlerHookHandler {
  return function requireIntegrationToken(...required: IntegrationScope[]): preHandlerHookHandler {
    return async function integrationGuard(request) {
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
