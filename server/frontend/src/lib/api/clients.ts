/**
 * CRUD calls for the `Client` policy entity (#51 contract, #189 editor).
 *
 * Same proven shape as `$lib/api/users` (#53): thin typed wrappers over
 * {@link apiFetch}, with the request/response types imported from the shared
 * `/api` contract so the frontend never re-declares a DTO. A `Client` is the
 * supervised Linux desktop record the admin enrols and then attaches policy to.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  ClientResponse,
  CreateClientRequest,
  EnrolmentTokenResponse,
  MintEnrolmentTokenRequest,
  UpdateClientRequest,
} from "./contract.js";

/** List all enrolled clients, in the order `/api` returns them. */
export function listClients(): Promise<ClientResponse[]> {
  return apiFetch<ClientResponse[]>("/clients");
}

/** Create a client; the server validates `hostname`/`sshUser` and returns the row. */
export function createClient(input: CreateClientRequest): Promise<ClientResponse> {
  return apiFetch<ClientResponse>("/clients", { method: "POST", body: input });
}

/** Patch a client; `input` must carry at least one field (server enforces). */
export function updateClient(id: number, input: UpdateClientRequest): Promise<ClientResponse> {
  return apiFetch<ClientResponse>(`/clients/${id}`, { method: "PATCH", body: input });
}

/** Delete a client. Resolves on the server's `204`. */
export function deleteClient(id: number): Promise<void> {
  return apiFetch<void>(`/clients/${id}`, { method: "DELETE" });
}

/**
 * Mint a single-use, short-lived enrolment token scoped to the supervised
 * user(s) the new client will carry (#77, surfaced by the enrol-a-client flow
 * in #194). The plaintext `token` is returned **once** — only its hash is
 * stored — so the caller must show it immediately.
 */
export function mintEnrolmentToken(
  input: MintEnrolmentTokenRequest,
): Promise<EnrolmentTokenResponse> {
  return apiFetch<EnrolmentTokenResponse>("/clients/enrolment-tokens", {
    method: "POST",
    body: input,
  });
}
