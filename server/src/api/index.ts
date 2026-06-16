/**
 * JSON API: zod DTOs and routes shared by both frontends and external
 * integrators.
 *
 * This barrel is the documented import surface for the SvelteKit frontend and
 * for any code that needs the API contract: the inferred request/response
 * types (`z.infer`) and the shared error envelope live here, alongside
 * {@link registerApi} for mounting the routes. See `docs/architecture.md` →
 * "API conventions".
 */
export const moduleName = "api";

export { registerApi, apiPlugin } from "./plugin.js";
export {
  ApiError,
  ApiValidationError,
  errorDetailSchema,
  errorEnvelopeSchema,
  zodIssuesToDetails,
  type ErrorDetail,
  type ErrorEnvelope,
} from "./errors.js";
export { metaResponseSchema, type MetaResponse } from "./meta.js";
export type { ZodTypeProvider } from "./validation.js";
