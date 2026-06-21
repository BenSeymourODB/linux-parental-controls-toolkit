/**
 * Calls for the `UserOnClient` link (#51 contract, #189 editor).
 *
 * Same proven shape as `$lib/api/activities` (#53/#189): thin typed wrappers
 * over {@link apiFetch}, with the request/response types imported from the
 * shared `/api` contract so the frontend never re-declares a DTO. A link maps
 * a policy `User` to a Linux account (`linuxUsername` + `linuxUid`) on a given
 * `Client`; the routes are nested under the user so the collection is scoped to
 * one supervised user at a time.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { LinkResponse, UpsertLinkRequest } from "./contract.js";

/** List the client links for one user, in the order `/api` returns them. */
export function listUserLinks(userId: number): Promise<LinkResponse[]> {
  return apiFetch<LinkResponse[]>(`/users/${userId}/clients`);
}

/**
 * Create-or-update the link between `userId` and `clientId` (idempotent `PUT`).
 * The server enforces that the Linux UID is unique per client and returns the
 * stored row.
 */
export function upsertLink(
  userId: number,
  clientId: number,
  input: UpsertLinkRequest,
): Promise<LinkResponse> {
  return apiFetch<LinkResponse>(`/users/${userId}/clients/${clientId}`, {
    method: "PUT",
    body: input,
  });
}

/** Remove the link between `userId` and `clientId`. Resolves on the `204`. */
export function deleteLink(userId: number, clientId: number): Promise<void> {
  return apiFetch<void>(`/users/${userId}/clients/${clientId}`, { method: "DELETE" });
}
