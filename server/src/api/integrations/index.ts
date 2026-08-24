/**
 * Public surface of the integration-token API module (#114): the route
 * registrar and the inferred DTO types the frontend consumes.
 *
 * License boundary: none touched.
 */
export { registerIntegrationRoutes } from "./routes.js";
export { registerIntegrationGrantRoutes } from "./grants-routes.js";
export {
  createGrantSchema,
  grantResponseSchema,
  type CreateGrantRequest,
  type GrantResponse,
} from "./grant-dtos.js";
export {
  createIntegrationTokenSchema,
  integrationScopeSchema,
  integrationTokenCreatedSchema,
  integrationTokenListSchema,
  integrationTokenSummarySchema,
  type CreateIntegrationTokenRequest,
  type IntegrationTokenCreatedResponse,
  type IntegrationTokenListResponse,
  type IntegrationTokenSummaryResponse,
} from "./dtos.js";
