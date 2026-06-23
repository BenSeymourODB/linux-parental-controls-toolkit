/**
 * Calls for the per-integration API tokens (#114 contract, #250 admin UI).
 *
 * The same proven shape as `$lib/api/clients`: thin typed wrappers over
 * {@link apiFetch}, with the request/response types imported from the shared
 * `/api` contract so the frontend never re-declares a DTO. An integration token
 * is a scoped, revocable machine credential an external system (e.g. the family
 * calendar) uses on the inbound `/api/integrations/*` endpoints.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  CreateIntegrationTokenRequest,
  IntegrationTokenCreatedResponse,
  IntegrationTokenListResponse,
  IntegrationTokenSummaryResponse,
} from "./contract.js";

/** List all integration tokens as summaries — never includes a secret. */
export function listIntegrationTokens(): Promise<IntegrationTokenListResponse> {
  return apiFetch<IntegrationTokenListResponse>("/integrations/tokens");
}

/**
 * Mint an integration token. The response carries the plaintext `secret`
 * **once** — only its hash is stored server-side — so the caller must show it
 * immediately and never re-fetch it.
 */
export function createIntegrationToken(
  input: CreateIntegrationTokenRequest,
): Promise<IntegrationTokenCreatedResponse> {
  return apiFetch<IntegrationTokenCreatedResponse>("/integrations/tokens", {
    method: "POST",
    body: input,
  });
}

/** Revoke a token (idempotent); resolves to the updated summary. */
export function revokeIntegrationToken(id: number): Promise<IntegrationTokenSummaryResponse> {
  return apiFetch<IntegrationTokenSummaryResponse>(`/integrations/tokens/${id}/revoke`, {
    method: "POST",
  });
}
