/**
 * Per-client bearer authentication for the event stream (#100, Phase 8b).
 *
 * The `pct-client-bridge` connects to `/api/events/stream` with the per-client
 * bearer token issued at enrolment (#77) in an `Authorization: Bearer <token>`
 * header. {@link authenticateEventClient} resolves that header to the enrolled
 * {@link ClientRow}, or throws a `401` in the shared error envelope — the same
 * hashed-at-rest, constant-cost lookup the enrol exchange uses (the token is a
 * 256-bit random secret, so a SHA-256 lookup is the right primitive, not a
 * slow password hash — see `auth/secret-token.ts`).
 *
 * It is the route's `preHandler` (so a bad credential is rejected *before* the
 * WebSocket upgrade), and is a plain function so it unit-tests without a
 * socket.
 *
 * License boundary: none touched — plain TypeScript + Drizzle + `node:crypto`.
 */
import { hashToken } from "../auth/secret-token.js";
import { ApiError } from "../api/errors.js";
import { parseBearer } from "../api/clients/routes.js";
import type { PolicyDb } from "../policy/db.js";
import { findClientByBearerTokenHash, type ClientRow } from "../policy/repository.js";

/**
 * Authenticate an event-stream connection from its `Authorization` header.
 *
 * Returns the enrolled client on success. Throws `ApiError(401)` when the
 * header is missing/malformed or the token matches no enrolled client — the
 * same opaque `unauthorized` code either way, so a caller cannot distinguish
 * "no token" from "wrong token".
 */
export function authenticateEventClient(
  db: PolicyDb,
  authorization: string | undefined,
): ClientRow {
  const token = parseBearer(authorization);
  if (token === null) {
    throw new ApiError(
      401,
      "unauthorized",
      "Missing or malformed Authorization: Bearer <client-token> header",
    );
  }
  const client = findClientByBearerTokenHash(db, hashToken(token));
  if (client === undefined) {
    throw new ApiError(401, "unauthorized", "Unknown or invalid client token");
  }
  return client;
}
