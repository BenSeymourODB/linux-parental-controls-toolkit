/**
 * Read-only calls for the client health/status surface (#194, frontend half of
 * #81). The admin "Client Health" view renders, per enrolled client, its
 * reachability, per-component health, and offline + queued-change state.
 *
 * Same proven shape as the CRUD wrappers (`$lib/api/clients`, #53): thin typed
 * wrappers over {@link apiFetch}, with the response types imported from the
 * shared `/api` contract so the frontend never re-declares a DTO. These are
 * reads only — they never mutate client state.
 *
 * License boundary: none — JSON API only. The remote SSH probing that produces
 * this data happens server-side behind the transport facade.
 */
import { apiFetch } from "./client.js";
import type { ClientHealthResponse } from "./contract.js";

/** List health/status for every enrolled client, in the order `/api` returns. */
export function listClientHealth(): Promise<ClientHealthResponse[]> {
  return apiFetch<ClientHealthResponse[]>("/clients/health");
}

/** Fetch health/status for a single client; rejects with a `404` if unknown. */
export function getClientHealth(id: number): Promise<ClientHealthResponse> {
  return apiFetch<ClientHealthResponse>(`/clients/${id}/health`);
}
