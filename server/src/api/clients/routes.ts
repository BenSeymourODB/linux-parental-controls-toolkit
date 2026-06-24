/**
 * Client-enrolment routes (#77): the admin "mint a token" endpoint and the
 * install script's "enrol" endpoint.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so both
 * inherit the zod validator + shared error envelope. The split in *who* may
 * call them is deliberate:
 *  - `POST /clients/enrolment-tokens` is admin-only (`requireAdmin`) — minting
 *    a credential is an admin action.
 *  - `POST /clients/enrol` is **not** session-guarded: the install script has
 *    no admin session. It authenticates with the one-time enrolment token in
 *    the `Authorization: Bearer …` header, validated inside the service. This
 *    is the single intentional unauthenticated-by-session write, and it is
 *    gated by a 256-bit, hashed-at-rest, single-use, expiring token.
 *
 * Handlers stay thin: validate via the DTOs, delegate to `./service.ts`, and
 * serialise dates as ISO strings.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify.
 */
import type { FastifyInstance } from "fastify";

import { parseBearer } from "../../auth/bearer.js";
import { FixedWindowRateLimiter } from "../../auth/rate-limit.js";
import type { Settings } from "../../config.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  enrolClientSchema,
  mintEnrolmentTokenSchema,
  type EnrolResponse,
  type EnrolmentTokenResponse,
} from "./dtos.js";
import { enrolClient, mintEnrolmentToken } from "./service.js";

/**
 * Per-IP failed-attempt budget for `POST /clients/enrol` before it returns 429
 * (#154). Higher than the login limit (5): a fumbled install can legitimately
 * retry a mistyped/expired token a few times, while ten *auth failures* in the
 * window from one IP is plainly abuse rather than a botched enrolment. Only
 * token-auth failures (401s) count; a valid-token 400/409 does not.
 */
export const ENROL_RATE_LIMIT_MAX_ATTEMPTS = 10;
/** Window for {@link ENROL_RATE_LIMIT_MAX_ATTEMPTS}; matches the login window. */
export const ENROL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Register the enrolment routes on an already-`/api`-prefixed scope. Call after
 * {@link registerAuth} so `scope.requireAdmin` is decorated; `settings` carries
 * the SSH-public-key path the enrol response returns.
 */
export function registerClientEnrolmentRoutes(scope: FastifyInstance, settings: Settings): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  // Per-app instance (mirrors the login limiter in `registerAuth`): in-process,
  // not shared across app builds, so tests get a fresh window each time.
  const enrolLimiter = new FixedWindowRateLimiter({
    maxAttempts: ENROL_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: ENROL_RATE_LIMIT_WINDOW_MS,
  });

  typed.post(
    "/clients/enrolment-tokens",
    { preHandler: scope.requireAdmin, schema: { body: mintEnrolmentTokenSchema } },
    async (request, reply): Promise<EnrolmentTokenResponse> => {
      const result = mintEnrolmentToken(scope.db, request.body);
      request.log.info(
        { event: "enrolment_token_minted", tokenId: result.id },
        "enrolment token minted",
      );
      reply.code(201);
      return { id: result.id, token: result.token, expiresAt: result.expiresAt.toISOString() };
    },
  );

  // Intentionally NOT behind requireAdmin — authenticated by the bearer
  // enrolment token, which the service validates.
  //
  // A per-IP failed-attempt limiter (#154) backstops this unauthenticated-by-
  // session surface in the application layer. The enrolment token is a 256-bit
  // hashed-at-rest secret, so this is not the primary brute-force defence — it
  // is cheap defence-in-depth that does not assume a reverse proxy is present.
  // Volumetric/DoS protection still belongs at the reverse proxy (Phase 11,
  // docs/server-deployment.md → "Reverse proxy", #119). Only token-auth
  // failures (401s) count toward the budget; a successful enrol clears the key,
  // and a valid-token 400/409 is left neutral (the caller proved possession of
  // a real token, so it is not abuse). Rejections remain logged in the service.
  typed.post(
    "/clients/enrol",
    { schema: { body: enrolClientSchema } },
    async (request, reply): Promise<EnrolResponse> => {
      const key = request.ip;
      if (enrolLimiter.isBlocked(key)) {
        throw new ApiError(
          429,
          "too_many_requests",
          "Too many failed enrolment attempts; try again later",
        );
      }

      const token = parseBearer(request.headers.authorization);
      if (token === null) {
        enrolLimiter.recordFailure(key);
        throw new ApiError(
          401,
          "unauthorized",
          "Missing or malformed Authorization: Bearer <enrolment-token> header",
        );
      }

      try {
        const result = enrolClient(scope.db, token, request.body, {
          sshPublicKeyPath: settings.sshPublicKeyPath,
          log: request.log,
        });
        enrolLimiter.recordSuccess(key);
        reply.code(201);
        return result;
      } catch (err) {
        // Count only token-auth failures (unknown/used/expired token → 401);
        // a valid-token 400/409 is a real client's mistake, not an attacker.
        if (err instanceof ApiError && err.statusCode === 401) {
          enrolLimiter.recordFailure(key);
        }
        throw err;
      }
    },
  );
}
