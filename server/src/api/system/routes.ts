/**
 * Read-only system-status routes (#39): `GET /api/system/ansible`.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so it
 * inherits the zod validator + shared error envelope and sits behind
 * `requireAdmin` — first-run subsystem health is admin information. The handler
 * is thin: read the {@link AnsibleVenvStatus} snapshot off the `app.ansibleVenv`
 * supervisor decorated in `buildApp` and serialise it.
 *
 * This is the contract the admin UI consumes to surface whether Ansible is
 * ready (and, on a network-less first run, *why* it isn't) — the
 * "feature disabled + error surfaced" behaviour `docs/server-deployment.md` →
 * "First-run setup" requires.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify.
 */
import type { FastifyInstance } from "fastify";

import type { ZodTypeProvider } from "../validation.js";
import { toAnsibleVenvStatusResponse, type AnsibleVenvStatusResponse } from "./dtos.js";

/**
 * Register the system-status read routes on an already-`/api`-prefixed scope.
 * Call after {@link registerAuth} so `scope.requireAdmin` is decorated; reads
 * the `ansibleVenv` supervisor decorated onto the app in `buildApp`.
 */
export function registerSystemRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/system/ansible",
    { preHandler: scope.requireAdmin },
    async (): Promise<AnsibleVenvStatusResponse> =>
      toAnsibleVenvStatusResponse(scope.ansibleVenv.status),
  );
}
