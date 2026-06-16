/**
 * The `/api` Fastify plugin: one encapsulated scope that installs the shared
 * validation/envelope conventions and mounts the JSON routes. Mounting it
 * under the `/api` prefix keeps the conventions (and any future policy/auth/
 * integration routes) from touching `/`, `/healthz`, `/admin`, or `/app`.
 *
 * License boundary: none touched.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { registerMetaRoute } from "./meta.js";
import { installApiConventions } from "./validation.js";

/** The encapsulated `/api` plugin: conventions first, then routes. */
export const apiPlugin: FastifyPluginAsync = async (scope) => {
  installApiConventions(scope);
  registerMetaRoute(scope);
};

/** Mount the JSON API under `/api` on the given app. */
export function registerApi(app: FastifyInstance): void {
  app.register(apiPlugin, { prefix: "/api" });
}
