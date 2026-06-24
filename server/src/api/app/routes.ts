/**
 * Per-user PIN auth routes (#112):
 *
 * - **Admin PIN management** (`PUT`/`DELETE`/`GET /api/users/:userId/pin`) —
 *   the parent sets, resets, clears, or checks a child's PIN from `/admin`.
 *   Admin-guarded; the response only ever reveals *whether* a PIN is set.
 * - **`/app` child session** (`POST`/`DELETE`/`GET /api/app/session`) — the
 *   child logs in with `userId` + PIN, logs out, or queries login state.
 * - **`GET /api/app/me`** — the first **own-data-only** read, gated by the PIN
 *   guard and scoped to `request.pinUser`, never a caller-supplied id.
 *
 * Registered inside the `/api` plugin scope after `registerAuth`, so they
 * inherit the zod validator + shared error envelope and can apply both
 * `scope.requireAdmin` and `scope.requirePinSession`. Login throttling reuses
 * the same `FixedWindowRateLimiter` as admin login, keyed per supervised user.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify; PIN
 * hashing reuses `auth/passwords.ts` (Argon2id, MIT `argon2`).
 */
import type { FastifyInstance } from "fastify";

import type { Settings } from "../../config.js";
import { assertAuthConfigured } from "../../auth/guard.js";
import { hashPassword, verifyDummy, verifyPassword } from "../../auth/passwords.js";
import { clearPinSession, issuePinSession, readPinSession } from "../../auth/pin-session.js";
import { FixedWindowRateLimiter } from "../../auth/rate-limit.js";
import { getUser } from "../../policy/repository.js";
import { clearUserPin, getUserPinHash, hasUserPin, setUserPin } from "../../policy/user-pins.js";
import { ApiError } from "../errors.js";
import { userIdParamsSchema } from "../policy/dtos.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  pinLoginRequestSchema,
  setUserPinSchema,
  type AppMeResponse,
  type PinSessionResponse,
  type UserPinStatusResponse,
} from "./dtos.js";

/**
 * Register the PIN-auth routes on an already-`/api`-prefixed scope. Call after
 * {@link import("../../auth/index.js").registerAuth} so `scope.requireAdmin`
 * and `scope.requirePinSession` are decorated and `@fastify/cookie` is
 * installed. `settings.secretKey` decides whether sessions can be signed; the
 * session routes fail closed with `503 auth_not_configured` when it is unset.
 */
export function registerAppAuthRoutes(
  scope: FastifyInstance,
  settings: Pick<Settings, "secretKey">,
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const authConfigured = settings.secretKey !== undefined;
  const adminGuard = { preHandler: scope.requireAdmin };

  // Failed-PIN throttle. A dedicated instance (not shared with admin login) so
  // a child's typos can't lock the admin out and vice versa. Default 5 failures
  // / 15-minute window — see `auth/rate-limit`. The window is keyed by
  // `userId:ip` (see `loginKey`), not `userId` alone, so it throttles online
  // guessing from any single source without letting one source lock a child out
  // of their *own* device: an attacker hammering from another IP only fills
  // their own bucket, leaving the child's `userId:childIp` bucket untouched.
  const loginLimiter = new FixedWindowRateLimiter();
  const loginKey = (userId: number, ip: string): string => `${userId}:${ip}`;

  // --- Admin PIN management (/admin) ---------------------------------------

  typed.put(
    "/users/:userId/pin",
    { ...adminGuard, schema: { params: userIdParamsSchema, body: setUserPinSchema } },
    async (request): Promise<UserPinStatusResponse> => {
      const { userId } = request.params;
      if (getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      const hashedPin = await hashPassword(request.body.pin);
      setUserPin(scope.db, userId, hashedPin);
      request.log.info({ event: "user_pin_set", userId }, "user PIN set");
      return { pinSet: true };
    },
  );

  typed.delete(
    "/users/:userId/pin",
    { ...adminGuard, schema: { params: userIdParamsSchema } },
    async (request): Promise<UserPinStatusResponse> => {
      const { userId } = request.params;
      if (getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      const removed = clearUserPin(scope.db, userId);
      if (removed) {
        request.log.info({ event: "user_pin_cleared", userId }, "user PIN cleared");
      }
      return { pinSet: false };
    },
  );

  typed.get(
    "/users/:userId/pin",
    { ...adminGuard, schema: { params: userIdParamsSchema } },
    async (request): Promise<UserPinStatusResponse> => {
      const { userId } = request.params;
      if (getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      return { pinSet: hasUserPin(scope.db, userId) };
    },
  );

  // --- /app child-scoped session -------------------------------------------

  typed.post(
    "/app/session",
    { schema: { body: pinLoginRequestSchema } },
    async (request, reply): Promise<PinSessionResponse> => {
      assertAuthConfigured(authConfigured);

      const { userId, pin } = request.body;
      const key = loginKey(userId, request.ip);
      if (loginLimiter.isBlocked(key)) {
        throw new ApiError(
          429,
          "too_many_requests",
          "Too many failed PIN attempts; try again later",
        );
      }

      const user = getUser(scope.db, userId);
      const hashedPin = getUserPinHash(scope.db, userId);

      // Unknown user or no PIN set: still run a verify (against a dummy hash) so
      // the response time matches the real path and cannot reveal which user
      // ids exist or have a PIN configured.
      if (user === undefined || hashedPin === undefined) {
        await verifyDummy(pin);
        loginLimiter.recordFailure(key);
        throw new ApiError(401, "invalid_credentials", "Invalid user or PIN");
      }

      if (!(await verifyPassword(hashedPin, pin))) {
        loginLimiter.recordFailure(key);
        throw new ApiError(401, "invalid_credentials", "Invalid user or PIN");
      }

      loginLimiter.recordSuccess(key);
      issuePinSession(reply, user.id);
      return { authenticated: true, user: { id: user.id, displayName: user.displayName } };
    },
  );

  // Logout is idempotent and needs no secret (clearing a cookie does not sign
  // anything), so it works even when auth is unconfigured.
  typed.delete("/app/session", async (_request, reply): Promise<PinSessionResponse> => {
    clearPinSession(reply);
    return { authenticated: false };
  });

  typed.get("/app/session", async (request): Promise<PinSessionResponse> => {
    assertAuthConfigured(authConfigured);
    const session = readPinSession(request);
    if (session === null) {
      return { authenticated: false };
    }
    // The session is cryptographically valid, but the user may have been
    // deleted since it was issued — treat that as logged out.
    const user = getUser(scope.db, session.uid);
    if (user === undefined) {
      return { authenticated: false };
    }
    return { authenticated: true, user: { id: user.id, displayName: user.displayName } };
  });

  // The first own-data-only read: scoped strictly to the session's user.
  typed.get(
    "/app/me",
    { preHandler: scope.requirePinSession },
    async (request): Promise<AppMeResponse> => {
      const pinUser = request.pinUser;
      if (pinUser === null) {
        // Unreachable in practice — the guard sets pinUser or throws — but keeps
        // the handler total without an unchecked assertion.
        throw new ApiError(401, "unauthorized", "Authentication required");
      }
      const user = getUser(scope.db, pinUser.userId);
      if (user === undefined) {
        throw new ApiError(401, "unauthorized", "Authentication required");
      }
      return { id: user.id, displayName: user.displayName, tz: user.tz };
    },
  );
}
