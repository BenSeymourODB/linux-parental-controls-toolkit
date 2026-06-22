/**
 * The integration-token scope vocabulary (#114).
 *
 * Per-integration API tokens carry a set of scopes that gate what an external
 * system may do through `/api/integrations/*`. The vocabulary is fixed here as
 * the single source of truth, matching `docs/architecture.md` → "External
 * integrations" (per-integration tokens are "scoped (e.g. `grants:write`,
 * `policy:read`)"):
 *
 * - `grants:write` — create grants via `POST /api/integrations/grants` (#113).
 * - `policy:read` — read effective policy / status for the integrator's UI.
 *
 * A new scope is added here deliberately rather than absorbed as free-form
 * text, so the DTO (`api/integrations/dtos.ts`) and the guard
 * (`integrations/guard.ts`) can never drift from the set the store accepts.
 *
 * License boundary: none touched — plain TypeScript.
 */

/** The scopes an {@link import("../policy/schema.js").integrationTokens} row may carry. */
export const INTEGRATION_SCOPES = ["grants:write", "policy:read"] as const;

/** A single integration-token scope; one of {@link INTEGRATION_SCOPES}. */
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];
