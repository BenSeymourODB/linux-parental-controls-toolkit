/**
 * Post-enrol connectivity-verification route (#354):
 * `POST /api/clients/:id/verify-connection`.
 *
 * Enrolment is client→server HTTP only, so it never proves the *dashboard can
 * reach the client over SSH* — the direction every push, probe, and telemetry
 * pull uses. This route runs that classified round-trip on demand, triggered by
 * the installer as a late step (after the dashboard's key is authorised), so an
 * install that "succeeds" but leaves the server unable to reach the box fails
 * loudly at install time instead of silently (the v0.1.0-alpha.5 incident).
 *
 * Auth is the client's **own** per-client bearer token (issued at enrol), not an
 * admin session — the installer has no admin session, and the same credential
 * already authenticates the event stream (`events/auth.ts`). The `:id` in the
 * path must equal the authenticated client, so a client can only ever ask the
 * server to probe **its own** recorded address — it cannot make the dashboard
 * hammer arbitrary hosts. A per-client fixed-window budget caps how often one
 * client can trigger the (real, SSH-connecting) check.
 *
 * The live {@link ClientConnectionVerifier} is injected via `deps`; until the
 * SSH-key bootstrap (#39) plumbs credentials it is absent and the route reports
 * the transport as unavailable (`503`), mirroring the time-today (#257) /
 * push-now (#304) levers rather than silently no-op'ing.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify; the remote
 * work happens inside the injected verifier, over the SSH subprocess facade.
 */
import type { FastifyInstance } from "fastify";

import { parseBearer } from "../../auth/bearer.js";
import { FixedWindowRateLimiter } from "../../auth/rate-limit.js";
import { hashToken } from "../../auth/secret-token.js";
import { findClientByBearerTokenHash, recordClientVerification } from "../../policy/repository.js";
import type { ClientConnectionVerifier } from "../../transport/health/index.js";
import { ApiError } from "../errors.js";
import { idParamsSchema } from "../policy/dtos.js";
import type { ZodTypeProvider } from "../validation.js";
import type { VerifyConnectionResponse } from "./verify-dtos.js";

/**
 * Verification attempts one client may trigger within a window before it gets a
 * `429`. Generous — the installer legitimately calls this a handful of times
 * across a botched install and its retries — while still capping a boot-loop
 * that would make the server SSH-connect on every cycle. Every attempt consumes
 * budget (each triggers real SSH work regardless of outcome), so the limiter is
 * driven as a plain per-client counter, never cleared on success.
 */
export const VERIFY_RATE_LIMIT_MAX_ATTEMPTS = 20;
/** Window for {@link VERIFY_RATE_LIMIT_MAX_ATTEMPTS}; matches the enrol/login window. */
export const VERIFY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Dependencies the verify-connection route needs from the host app. */
export interface ClientVerifyRoutesDeps {
  /**
   * The live SSH connection verifier. Omitted until #39 plumbs SSH credentials;
   * without it the route reports the transport as unavailable (`503`).
   */
  verifier?: ClientConnectionVerifier;
}

/**
 * Register the verify-connection route on an already-`/api`-prefixed scope.
 * Intentionally **not** behind `requireAdmin`: it authenticates with the
 * client's own bearer token (validated here), the single client-credentialled
 * write beside `POST /clients/enrol`.
 */
export function registerClientVerifyRoutes(
  scope: FastifyInstance,
  deps: ClientVerifyRoutesDeps = {},
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  // Per-app instance (mirrors the enrol limiter): in-process, not shared across
  // app builds, so tests get a fresh window each time.
  const limiter = new FixedWindowRateLimiter({
    maxAttempts: VERIFY_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: VERIFY_RATE_LIMIT_WINDOW_MS,
  });

  typed.post(
    "/clients/:id/verify-connection",
    { schema: { params: idParamsSchema } },
    async (request): Promise<VerifyConnectionResponse> => {
      // Authenticate as some enrolled client by its per-client bearer token —
      // the same hashed-at-rest lookup the event stream uses. An opaque 401
      // either way so a caller can't distinguish "no token" from "wrong token".
      const token = parseBearer(request.headers.authorization);
      if (token === null) {
        throw new ApiError(
          401,
          "unauthorized",
          "Missing or malformed Authorization: Bearer <client-token> header",
        );
      }
      const client = findClientByBearerTokenHash(scope.db, hashToken(token));
      if (client === undefined) {
        throw new ApiError(401, "unauthorized", "Unknown or invalid client token");
      }

      // A client may only verify its OWN connection: the path id must match the
      // authenticated client. This is the "can't make the server hammer
      // arbitrary hosts" guarantee — the verifier only ever targets `client`'s
      // own recorded address.
      if (client.id !== request.params.id) {
        throw new ApiError(403, "forbidden", "A client may only verify its own connection");
      }

      // No verifier wired (dev/CI/tests, or a server before first-run keygen,
      // #39): there is no SSH pool to round-trip over. Report unavailable rather
      // than record a bogus outcome. Cheap — checked before consuming budget.
      const { verifier } = deps;
      if (verifier === undefined) {
        throw new ApiError(
          503,
          "verification_unavailable",
          "SSH connectivity verification is not configured on this server yet (#39)",
        );
      }

      // Budget the (real, SSH-connecting) work per client. Every attempt counts,
      // pass or fail, so this is a plain fixed-window counter — never cleared.
      const key = String(client.id);
      if (limiter.isBlocked(key)) {
        throw new ApiError(
          429,
          "too_many_requests",
          "Too many verification attempts; try again later",
        );
      }
      limiter.recordFailure(key);

      const result = await verifier.verify(client);
      recordClientVerification(scope.db, client.id, {
        reachable: result.reachable,
        reason: result.reason,
        at: result.at,
      });
      request.log.info(
        {
          event: "client_connection_verified",
          clientId: client.id,
          reachable: result.reachable,
          ...(result.reason === null ? {} : { failureClass: result.reason }),
        },
        "client connectivity verification ran",
      );

      return {
        reachable: result.reachable,
        ...(result.reason === null ? {} : { failureClass: result.reason }),
        detail: result.detail,
        verifiedAt: result.at.toISOString(),
      };
    },
  );
}
