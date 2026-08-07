/**
 * Calls for the data-retention windows API (#136 contract, #214 admin UI).
 *
 * The same proven shape as `$lib/api/integration-tokens`: thin typed wrappers
 * over {@link apiFetch}, with the request/response types imported from the
 * shared `/api` contract so the frontend never re-declares a DTO. Retention
 * config is a global default window (environment-configured, read-only here)
 * plus per-category overrides the admin can pin or clear.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  RetentionCategory,
  RetentionConfigResponse,
  RetentionEntryResponse,
  SetRetentionOverrideRequest,
} from "./contract.js";

/** The full retention config: the global default plus every category's entry. */
export function fetchRetention(): Promise<RetentionConfigResponse> {
  return apiFetch<RetentionConfigResponse>("/retention");
}

/**
 * Pin an override for one category — a custom window (`{ keepForever: false,
 * days }`) or keep-forever (`{ keepForever: true }`). Resolves to the resulting
 * `override` entry.
 */
export function setRetentionOverride(
  category: RetentionCategory,
  body: SetRetentionOverrideRequest,
): Promise<RetentionEntryResponse> {
  return apiFetch<RetentionEntryResponse>(`/retention/${encodeURIComponent(category)}`, {
    method: "PUT",
    body,
  });
}

/**
 * Clear a category's override, reverting it to the global default. Idempotent:
 * clearing a category with no override still resolves to its default entry.
 */
export function clearRetentionOverride(
  category: RetentionCategory,
): Promise<RetentionEntryResponse> {
  return apiFetch<RetentionEntryResponse>(`/retention/${encodeURIComponent(category)}`, {
    method: "DELETE",
  });
}
