/**
 * The reusable admin guard (#52).
 *
 * `makeRequireAdmin` builds a Fastify `preHandler` that rejects any request
 * without a valid admin session with a `401` in the shared error envelope. It
 * is decorated onto the `/api` scope as `app.requireAdmin` so the policy routes
 * (#51) and any other admin-only route apply it with
 * `{ preHandler: app.requireAdmin }`. On success it records the authenticated
 * admin on `request.admin` for downstream handlers.
 *
 * License boundary: none touched.
 */
import type { preHandlerHookHandler } from "fastify";

import { ApiError } from "../api/errors.js";
import { readSession } from "./session.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Admin guard `preHandler` (#52): apply with `{ preHandler: app.requireAdmin }`
     * to gate a route behind the admin session. Decorated by `registerAuth`.
     */
    requireAdmin: preHandlerHookHandler;
  }
  interface FastifyRequest {
    /** The authenticated admin, set by {@link makeRequireAdmin}; `null` until then. */
    admin: { username: string } | null;
  }
}

/**
 * Throw a `503 auth_not_configured` if `PCT_SECRET_KEY` is unset. A session
 * cannot be signed or verified without it, so login, logout, and the guard all
 * fail closed with a clear, machine-readable code rather than a confusing 500.
 */
export function assertAuthConfigured(authConfigured: boolean): void {
  if (!authConfigured) {
    throw new ApiError(
      503,
      "auth_not_configured",
      "Authentication is not configured: set PCT_SECRET_KEY",
    );
  }
}

/**
 * Build the admin guard. `authConfigured` is whether `PCT_SECRET_KEY` is set;
 * when it is not, the guard fails closed via {@link assertAuthConfigured}.
 */
export function makeRequireAdmin(authConfigured: boolean): preHandlerHookHandler {
  return async function requireAdmin(request) {
    assertAuthConfigured(authConfigured);
    const session = readSession(request);
    if (session === null) {
      throw new ApiError(401, "unauthorized", "Authentication required");
    }
    request.admin = { username: session.sub };
  };
}
