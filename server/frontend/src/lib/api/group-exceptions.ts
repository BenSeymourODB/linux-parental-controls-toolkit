/**
 * CRUD calls for group-targeted `Exception` rules (#182 backend, #363 editor).
 *
 * Same thin-wrapper shape as `$lib/api/exceptions` (#189): a `GroupException` is
 * a one-off allow/deny/extend for a slot, applied to every member of a
 * {@link import("./contract.js").UserGroupResponse} over its `effectiveFrom` →
 * `expiresAt` window. As with group budgets, **create is nested** under the
 * group while **update / delete are flat by id**, and the update reuses the
 * plain-exception `UpdateExceptionRequest` (no separate group-update schema).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  CreateGroupExceptionRequest,
  GroupExceptionResponse,
  UpdateExceptionRequest,
} from "./contract.js";

/** List a group's exceptions, in the order `/api` returns them. */
export function listGroupExceptions(groupId: number): Promise<GroupExceptionResponse[]> {
  return apiFetch<GroupExceptionResponse[]>(`/user-groups/${groupId}/exceptions`);
}

/** Create an exception on `groupId`; the server validates target + window. */
export function createGroupException(
  groupId: number,
  input: CreateGroupExceptionRequest,
): Promise<GroupExceptionResponse> {
  return apiFetch<GroupExceptionResponse>(`/user-groups/${groupId}/exceptions`, {
    method: "POST",
    body: input,
  });
}

/** Update a group exception (any subset of its fields). */
export function updateGroupException(
  id: number,
  input: UpdateExceptionRequest,
): Promise<GroupExceptionResponse> {
  return apiFetch<GroupExceptionResponse>(`/group-exceptions/${id}`, {
    method: "PATCH",
    body: input,
  });
}

/** Delete a group exception. Resolves on the server's `204`. */
export function deleteGroupException(id: number): Promise<void> {
  return apiFetch<void>(`/group-exceptions/${id}`, { method: "DELETE" });
}
