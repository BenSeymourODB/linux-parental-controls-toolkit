/**
 * Auth routes (#52): `POST /api/auth/login`, `POST /api/auth/logout`,
 * `GET /api/auth/session`.
 *
 * Registered inside the `/api` plugin scope so they inherit its zod validator
 * compiler and shared error envelope. Login verifies the Argon2id hash and
 * issues the signed session cookie; logout clears it; session reports the
 * current login state for the admin UI.
 *
 * License boundary: none touched.
 */
import type { FastifyInstance } from "fastify";

import { ApiError } from "../api/errors.js";
import type { ZodTypeProvider } from "../api/validation.js";
import { getAdmin } from "./credentials.js";
import { loginRequestSchema, type SessionResponse } from "./dtos.js";
import { assertAuthConfigured } from "./guard.js";
import { verifyDummy, verifyPassword } from "./passwords.js";
import type { FixedWindowRateLimiter } from "./rate-limit.js";
import { clearSession, issueSession, readSession } from "./session.js";

/** Dependencies the auth routes close over. */
export interface AuthRouteDeps {
  /** Whether `PCT_SECRET_KEY` is set (sessions can be signed). */
  authConfigured: boolean;
  /** Failed-login limiter, keyed by client IP. */
  limiter: FixedWindowRateLimiter;
}

/** Register the auth routes on an already-`/api`-prefixed scope. */
export function registerAuthRoutes(scope: FastifyInstance, deps: AuthRouteDeps): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/auth/login",
    { schema: { body: loginRequestSchema } },
    async (request, reply): Promise<SessionResponse> => {
      assertAuthConfigured(deps.authConfigured);

      const key = request.ip;
      if (deps.limiter.isBlocked(key)) {
        throw new ApiError(
          429,
          "too_many_requests",
          "Too many failed login attempts; try again later",
        );
      }

      const { username, password } = request.body;
      const admin = getAdmin(scope.db);

      // Unknown username: still do a verify (against a dummy hash) so the
      // response time matches the real path and cannot be used to enumerate
      // the admin username.
      if (admin === undefined || admin.username !== username) {
        await verifyDummy(password);
        deps.limiter.recordFailure(key);
        throw new ApiError(401, "invalid_credentials", "Invalid username or password");
      }

      if (!(await verifyPassword(admin.passwordHash, password))) {
        deps.limiter.recordFailure(key);
        throw new ApiError(401, "invalid_credentials", "Invalid username or password");
      }

      deps.limiter.recordSuccess(key);
      issueSession(reply, admin.username);
      return { authenticated: true, username: admin.username };
    },
  );

  // Logout is idempotent and needs no secret (clearing a cookie does not sign
  // anything), so it works even when auth is unconfigured.
  typed.post("/auth/logout", async (_request, reply): Promise<SessionResponse> => {
    clearSession(reply);
    return { authenticated: false };
  });

  typed.get("/auth/session", async (request): Promise<SessionResponse> => {
    assertAuthConfigured(deps.authConfigured);
    const session = readSession(request);
    return session === null
      ? { authenticated: false }
      : { authenticated: true, username: session.sub };
  });
}
