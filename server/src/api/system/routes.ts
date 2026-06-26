/**
 * Read-only system-status routes (#39): `GET /api/system/ansible` and
 * `GET /api/system/adguard-managed` (#96).
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so they
 * inherit the zod validator + shared error envelope and sit behind
 * `requireAdmin` — first-run subsystem health is admin information. Each handler
 * is thin: read the snapshot off the supervisor decorated in `buildApp` and
 * serialise it.
 *
 * This is the contract the admin UI consumes to surface whether a first-run
 * subsystem is ready (and, on a network-less first run, *why* it isn't) — the
 * "feature disabled + error surfaced" behaviour `docs/server-deployment.md` →
 * "First-run setup" requires.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify.
 */
import type { FastifyInstance } from "fastify";

import type { ZodTypeProvider } from "../validation.js";
import {
  toAdGuardManagedStatusResponse,
  toAnsibleVenvStatusResponse,
  type AdGuardManagedStatusResponse,
  type AnsibleVenvStatusResponse,
} from "./dtos.js";

/**
 * Register the system-status read routes on an already-`/api`-prefixed scope.
 * Call after {@link registerAuth} so `scope.requireAdmin` is decorated; reads
 * the supervisors decorated onto the app in `buildApp`.
 */
export function registerSystemRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/system/ansible",
    { preHandler: scope.requireAdmin },
    async (): Promise<AnsibleVenvStatusResponse> =>
      toAnsibleVenvStatusResponse(scope.ansibleVenv.status),
  );

  typed.get(
    "/system/adguard-managed",
    { preHandler: scope.requireAdmin },
    async (): Promise<AdGuardManagedStatusResponse> =>
      toAdGuardManagedStatusResponse(scope.adguardManaged?.status ?? null),
  );
}
