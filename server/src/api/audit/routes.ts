/**
 * Read-only transport-audit route (#85): `GET /api/audit`.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so it
 * inherits the zod validator + shared error envelope and sits behind
 * `requireAdmin` — the audit log is admin-only (`CLAUDE.md` → "no privileged
 * in-process shortcuts"). The handler stays thin: validate the query, read via
 * the `transport/audit` repository over `app.db`, serialise.
 *
 * This is the contract the admin "audit view" consumes; the Svelte view itself
 * is deferred to its own issue (it depends on the `/admin/*` shell, #53).
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import { listAuditEntries } from "../../transport/audit/index.js";
import type { ZodTypeProvider } from "../validation.js";
import { listAuditQuerySchema, toAuditResponse, type AuditListResponse } from "./dtos.js";

/**
 * Register the audit read route on an already-`/api`-prefixed scope. Call after
 * {@link registerAuth} so `scope.requireAdmin` is decorated.
 */
export function registerAuditRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/audit",
    { preHandler: scope.requireAdmin, schema: { querystring: listAuditQuerySchema } },
    async (request): Promise<AuditListResponse> => {
      const { clientId, outcome, before, limit } = request.query;
      const rows = listAuditEntries(scope.db, {
        limit,
        ...(clientId !== undefined ? { clientId } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        ...(before !== undefined ? { before } : {}),
      });
      const entries = rows.map(toAuditResponse);
      // A full page may have more behind it; cursor on the last (oldest) id.
      const nextCursor =
        entries.length === limit ? (entries[entries.length - 1]?.id ?? null) : null;
      return { entries, nextCursor };
    },
  );
}
