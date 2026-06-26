/**
 * Integration-token management routes (#114).
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so they
 * inherit the zod validator + shared error envelope and can apply
 * `scope.requireAdmin`. All three are **admin-guarded**: minting, listing, and
 * revoking a machine credential are admin actions. The credential is *used* by
 * external systems on the inbound `/api/integrations/*` endpoints (the grants
 * endpoint #113, etc.), which authenticate with the bearer token via the guard
 * this module decorates as `scope.requireIntegrationToken`.
 *
 * Handlers stay thin: validate via the DTOs, delegate to `integrations/tokens`,
 * and serialise dates as ISO strings.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify.
 */
import type { FastifyInstance } from "fastify";

import { makeRequireIntegrationToken } from "../../integrations/guard.js";
import {
  issueIntegrationToken,
  listIntegrationTokenSummaries,
  revokeIntegrationToken,
  type IntegrationTokenSummary,
} from "../../integrations/tokens.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  createIntegrationTokenSchema,
  integrationTokenIdParamsSchema,
  type IntegrationTokenCreatedResponse,
  type IntegrationTokenListResponse,
  type IntegrationTokenSummaryResponse,
} from "./dtos.js";

/** Serialise a service summary to its wire DTO (dates → ISO strings). */
function toSummaryResponse(summary: IntegrationTokenSummary): IntegrationTokenSummaryResponse {
  return {
    id: summary.id,
    name: summary.name,
    scopes: summary.scopes,
    createdAt: summary.createdAt.toISOString(),
    lastUsedAt: summary.lastUsedAt?.toISOString() ?? null,
    revokedAt: summary.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Register the integration-token routes on an already-`/api`-prefixed scope.
 * Call after {@link import("../../auth/index.js").registerAuth} so
 * `scope.requireAdmin` is decorated. Also decorates
 * `scope.requireIntegrationToken` so the inbound integration endpoints (#113)
 * can gate themselves on a scoped bearer token.
 */
export function registerIntegrationRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  // The bearer guard used by the (future) inbound integration endpoints (#113).
  // Decorated here, bound to this scope's db, so those endpoints apply it with
  // `{ preHandler: scope.requireIntegrationToken("grants:write") }`.
  scope.decorate("requireIntegrationToken", makeRequireIntegrationToken(scope.db));

  typed.post(
    "/integrations/tokens",
    { preHandler: scope.requireAdmin, schema: { body: createIntegrationTokenSchema } },
    async (request, reply): Promise<IntegrationTokenCreatedResponse> => {
      const result = issueIntegrationToken(scope.db, request.body);
      request.log.info(
        { event: "integration_token_minted", tokenId: result.id, name: result.name },
        "integration token minted",
      );
      reply.code(201);
      return {
        id: result.id,
        name: result.name,
        scopes: result.scopes,
        secret: result.secret,
        createdAt: result.createdAt.toISOString(),
      };
    },
  );

  typed.get(
    "/integrations/tokens",
    { preHandler: scope.requireAdmin },
    async (): Promise<IntegrationTokenListResponse> =>
      listIntegrationTokenSummaries(scope.db).map(toSummaryResponse),
  );

  typed.post(
    "/integrations/tokens/:id/revoke",
    { preHandler: scope.requireAdmin, schema: { params: integrationTokenIdParamsSchema } },
    async (request): Promise<IntegrationTokenSummaryResponse> => {
      const summary = revokeIntegrationToken(scope.db, request.params.id);
      request.log.info(
        { event: "integration_token_revoked", tokenId: summary.id, name: summary.name },
        "integration token revoked",
      );
      return toSummaryResponse(summary);
    },
  );
}
