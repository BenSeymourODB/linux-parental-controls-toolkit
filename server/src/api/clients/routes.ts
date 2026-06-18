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
 * Extract the token from an `Authorization: Bearer <token>` header, or `null`
 * if the header is missing or not a non-empty bearer credential.
 */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/**
 * Register the enrolment routes on an already-`/api`-prefixed scope. Call after
 * {@link registerAuth} so `scope.requireAdmin` is decorated; `settings` carries
 * the SSH-public-key path the enrol response returns.
 */
export function registerClientEnrolmentRoutes(scope: FastifyInstance, settings: Settings): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

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
  // No per-IP rate limit is applied here (unlike the login route's
  // LoginRateLimiter): the token is a 256-bit random secret, so online guessing
  // is infeasible, and protecting the unauthenticated surface from volumetric
  // abuse belongs at the reverse proxy (Phase 11, docs/server-deployment.md →
  // "Reverse proxy"). Rejections are logged so abuse is observable. Revisit if
  // an application-layer limiter is wanted — tracked as a follow-up.
  typed.post(
    "/clients/enrol",
    { schema: { body: enrolClientSchema } },
    async (request, reply): Promise<EnrolResponse> => {
      const token = parseBearer(request.headers.authorization);
      if (token === null) {
        throw new ApiError(
          401,
          "unauthorized",
          "Missing or malformed Authorization: Bearer <enrolment-token> header",
        );
      }
      const result = enrolClient(scope.db, token, request.body, {
        sshPublicKeyPath: settings.sshPublicKeyPath,
        log: request.log,
      });
      reply.code(201);
      return result;
    },
  );
}
