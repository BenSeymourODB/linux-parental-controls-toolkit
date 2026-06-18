/**
 * The `/api` Fastify plugin: one encapsulated scope that installs the shared
 * validation/envelope conventions and mounts the JSON routes. Mounting it
 * under the `/api` prefix keeps the conventions (and the auth/policy/
 * integration routes) from touching `/`, `/healthz`, `/admin`, or `/app`.
 *
 * License boundary: none touched.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { registerAuth } from "../auth/index.js";
import type { Settings } from "../config.js";
import { registerClientEnrolmentRoutes } from "./clients/index.js";
import { registerMetaRoute } from "./meta.js";
import { registerPolicyRoutes } from "./policy/index.js";
import { installApiConventions } from "./validation.js";

/** Options the `/api` plugin needs from its host app. */
export interface ApiPluginOptions {
  /** Parsed settings (auth keys, etc.) threaded in from {@link registerApi}. */
  settings: Settings;
}

/**
 * The encapsulated `/api` plugin: conventions first, then auth (cookie plugin,
 * the `requireAdmin` guard, bootstrap, and the auth routes), then the rest of
 * the routes. Auth is installed before other routes so its `requireAdmin`
 * decoration is available to them within this scope.
 */
export const apiPlugin: FastifyPluginAsync<ApiPluginOptions> = async (scope, opts) => {
  installApiConventions(scope);
  await registerAuth(scope, opts.settings);
  registerMetaRoute(scope);
  // Policy CRUD (#51) — registered after auth so `scope.requireAdmin` exists.
  registerPolicyRoutes(scope);
  // Client enrolment (#77): admin-minted token + the install script's enrol
  // exchange. `settings` carries the SSH-public-key path the enrol response returns.
  registerClientEnrolmentRoutes(scope, opts.settings);
};

/** Mount the JSON API under `/api` on the given app. */
export function registerApi(app: FastifyInstance, settings: Settings): void {
  app.register(apiPlugin, { prefix: "/api", settings });
}
