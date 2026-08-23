/**
 * External inbound APIs (e.g. family-calendar reward grants, #114).
 *
 * The integration-token service and guard that gate `/api/integrations/*` for
 * external systems: the scope vocabulary ({@link ./scopes.js}), the token
 * lifecycle + authentication service ({@link ./tokens.js}), and the Fastify
 * guard factory ({@link ./guard.js}). Re-exported here as the module's public
 * surface, matching the barrel pattern used across `api/*` and `transport/*`.
 * Importing this barrel also registers the `fastify` module augmentation
 * declared in `./guard.js` (`app.requireIntegrationToken`, `request.integration`).
 *
 * License boundary: none touched — plain TypeScript, `node:crypto` (via
 * `auth/secret-token.ts`), Fastify, and Drizzle.
 */
export const moduleName = "integrations";

export { INTEGRATION_SCOPES, type IntegrationScope } from "./scopes.js";
export { makeRequireIntegrationToken } from "./guard.js";
export {
  issueIntegrationToken,
  listIntegrationTokenSummaries,
  revokeIntegrationToken,
  authenticateIntegrationToken,
  type IssuedIntegrationToken,
  type IntegrationTokenSummary,
  type AuthenticatedIntegration,
} from "./tokens.js";
