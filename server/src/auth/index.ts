/**
 * Single-admin authentication (#52): Argon2id password hashing, a signed
 * session cookie keyed on `PCT_SECRET_KEY`, login/logout/session routes, a
 * reusable admin guard, and first-admin bootstrap from the environment.
 *
 * The whole feature is encapsulated within the `/api` plugin scope by
 * {@link registerAuth}: the cookie plugin, the `requireAdmin` decoration, the
 * bootstrap hook, and the routes all live there, so the conventions never leak
 * onto `/`, `/healthz`, `/admin`, or `/app`. Scope boundary is deliberate —
 * one admin login, not a user system (`docs/server-deployment.md` →
 * "Authentication"); the policy-model `User` is a supervised person, not an
 * auth principal.
 *
 * License boundary: none touched. `argon2` (MIT) and `@fastify/cookie` (MIT)
 * are permissively licensed and linked in-process freely; no GPL component is
 * involved.
 */
import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";

import type { Settings } from "../config.js";
import { bootstrapAdmin } from "./credentials.js";
import { makeRequireAdmin } from "./guard.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { registerAuthRoutes } from "./routes.js";

/**
 * Wire authentication onto the `/api` scope.
 *
 * Registers `@fastify/cookie` (signing enabled only when `PCT_SECRET_KEY` is
 * set), decorates `app.requireAdmin` and `request.admin`, schedules the
 * first-admin bootstrap for when the app is ready, and mounts the auth routes.
 */
export async function registerAuth(
  scope: FastifyInstance,
  settings: Pick<Settings, "secretKey" | "adminUsername" | "adminPassword">,
): Promise<void> {
  const secret = settings.secretKey;
  const authConfigured = secret !== undefined;

  // Signing needs the secret; without it the cookie plugin is still registered
  // (so request.cookies parses) but auth endpoints fail closed with 503.
  await scope.register(cookie, secret !== undefined ? { secret } : {});

  scope.decorateRequest("admin", null);
  scope.decorate("requireAdmin", makeRequireAdmin(authConfigured));

  // Seed the first admin once the app (and app.db) are ready. Idempotent: a
  // restart with an existing admin is a no-op.
  scope.addHook("onReady", async () => {
    await bootstrapAdmin(scope.db, settings, scope.log);
  });

  registerAuthRoutes(scope, { authConfigured, limiter: new FixedWindowRateLimiter() });
}

export { makeRequireAdmin, assertAuthConfigured } from "./guard.js";
export {
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse,
} from "./dtos.js";
export { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./session.js";
export { bootstrapAdmin, getAdmin, type BootstrapResult } from "./credentials.js";
