/**
 * The reusable per-user PIN-session guard (#112).
 *
 * The child-scoped counterpart to {@link ./guard.ts}'s `requireAdmin`.
 * `makeRequirePinSession` builds a Fastify `preHandler` that rejects any
 * request without a valid PIN session with a `401` in the shared error
 * envelope. It is decorated onto the `/api` scope as `app.requirePinSession`,
 * so the **own-data** `/app` routes opt in with
 * `{ preHandler: app.requirePinSession }`. On success it records the
 * authenticated supervised user on `request.pinUser` for downstream handlers,
 * which must serve **only** that user's data — never a caller-supplied id.
 *
 * Deny-by-default: a PIN session reaches a route *only* if that route applies
 * this guard. Every existing route keeps `requireAdmin` and so rejects PIN
 * sessions outright, which is why adding own-data routes one at a time (#110/
 * #111) can never accidentally widen a PIN session's reach.
 *
 * License boundary: none touched.
 */
import type { preHandlerHookHandler } from "fastify";

import { ApiError } from "../api/errors.js";
import { assertAuthConfigured } from "./guard.js";
import { readPinSession } from "./pin-session.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Per-user PIN-session guard `preHandler` (#112): apply with
     * `{ preHandler: app.requirePinSession }` to gate a route behind a child's
     * PIN session, scoped to `request.pinUser`. Decorated by `registerAuth`.
     */
    requirePinSession: preHandlerHookHandler;
  }
  interface FastifyRequest {
    /** The authenticated supervised user, set by {@link makeRequirePinSession}; `null` until then. */
    pinUser: { userId: number } | null;
  }
}

/**
 * Build the PIN-session guard. `authConfigured` is whether `PCT_SECRET_KEY` is
 * set; when it is not, the guard fails closed via {@link assertAuthConfigured}
 * (a session cannot be verified without the signing key).
 */
export function makeRequirePinSession(authConfigured: boolean): preHandlerHookHandler {
  return async function requirePinSession(request) {
    assertAuthConfigured(authConfigured);
    const session = readPinSession(request);
    if (session === null) {
      throw new ApiError(401, "unauthorized", "Authentication required");
    }
    request.pinUser = { userId: session.uid };
  };
}
