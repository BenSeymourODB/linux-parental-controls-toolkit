/**
 * zod DTOs for the integration-token management surface (#114).
 *
 * As with every `/api/*` DTO these are the single contract shared with the
 * SvelteKit admin frontend — types are inferred, never hand-written twice
 * (`CLAUDE.md` → "api/ — zod DTOs ..."). The scope vocabulary is derived from
 * the canonical {@link INTEGRATION_SCOPES} tuple so the request validation and
 * the store can never drift.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { INTEGRATION_SCOPES } from "../../integrations/scopes.js";

/** Largest number of distinct scopes a single token may carry. */
const MAX_SCOPES = INTEGRATION_SCOPES.length;

/** One integration-token scope; one of {@link INTEGRATION_SCOPES}. */
export const integrationScopeSchema = z.enum(INTEGRATION_SCOPES);

/** Reject a scope list with duplicate entries. */
function distinctScopes(list: string[]): boolean {
  return new Set(list).size === list.length;
}

// --- Create (admin-guarded) ------------------------------------------------

export const createIntegrationTokenSchema = z.object({
  /** A unique, human-meaningful name for the integration (e.g. `calendar`). */
  name: z.string().trim().min(1).max(64),
  /** The scopes the token carries; at least one, all distinct. */
  scopes: z
    .array(integrationScopeSchema)
    .min(1)
    .max(MAX_SCOPES)
    .refine(distinctScopes, { message: "scopes must be distinct" }),
});

export const integrationTokenCreatedSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  scopes: z.array(integrationScopeSchema),
  /** The plaintext secret — returned **once**; only its hash is stored. */
  secret: z.string(),
  createdAt: z.string(),
});

// --- Read / revoke ---------------------------------------------------------

export const integrationTokenSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  scopes: z.array(integrationScopeSchema),
  createdAt: z.string(),
  /** Last time the token authenticated a request, or `null` if never used. */
  lastUsedAt: z.string().nullable(),
  /** When the token was revoked, or `null` while it is still active. */
  revokedAt: z.string().nullable(),
});

export const integrationTokenListSchema = z.array(integrationTokenSummarySchema);

/** Path params for the revoke route. */
export const integrationTokenIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type CreateIntegrationTokenRequest = z.infer<typeof createIntegrationTokenSchema>;
export type IntegrationTokenCreatedResponse = z.infer<typeof integrationTokenCreatedSchema>;
export type IntegrationTokenSummaryResponse = z.infer<typeof integrationTokenSummarySchema>;
export type IntegrationTokenListResponse = z.infer<typeof integrationTokenListSchema>;
