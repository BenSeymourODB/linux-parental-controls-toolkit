/**
 * Read-only DNS-status route (#95): `GET /api/dns`.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so it
 * inherits the zod validator + shared error envelope and sits behind
 * `requireAdmin` — where DNS rules end up is admin information (`CLAUDE.md` →
 * "no privileged in-process shortcuts"). The handler is thin: read the active
 * {@link DnsStatus} snapshot off the `app.adguard` decoration and serialise it.
 *
 * This is the contract the admin UI consumes to surface the active mode and its
 * health; the Svelte view (and the per-client blocklist editing it lives
 * alongside) is #97.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify.
 */
import type { FastifyInstance } from "fastify";

import type { ZodTypeProvider } from "../validation.js";
import { toDnsStatusResponse, type DnsStatusResponse } from "./dtos.js";

/**
 * Register the DNS-status read route on an already-`/api`-prefixed scope. Call
 * after {@link registerAuth} so `scope.requireAdmin` is decorated; reads the
 * `adguard` service decorated onto the app in `buildApp`.
 */
export function registerDnsRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/dns",
    { preHandler: scope.requireAdmin },
    async (): Promise<DnsStatusResponse> => toDnsStatusResponse(scope.adguard.status),
  );
}
