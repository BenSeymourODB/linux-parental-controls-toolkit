/**
 * CRUD + membership calls for the `UserGroup` policy entity (#181 contract,
 * #124 editor).
 *
 * Same proven shape as `$lib/api/activity-groups` (#189): thin typed wrappers
 * over {@link apiFetch}, with the request/response types imported from the
 * shared `/api` contract so the frontend never re-declares a DTO. A
 * `UserGroup` is a named bundle of supervised {@link UserResponse} rows that a
 * group-level schedule/exception can target; the membership endpoints
 * attach/detach individual users (a user may belong to ≥0 groups).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  CreateUserGroupRequest,
  UpdateUserGroupRequest,
  UserGroupResponse,
  UserResponse,
} from "./contract.js";

/** List all user groups, in the order `/api` returns them. */
export function listUserGroups(): Promise<UserGroupResponse[]> {
  return apiFetch<UserGroupResponse[]>("/user-groups");
}

/** Create a group; the server validates `name` (unique) and returns the row. */
export function createUserGroup(input: CreateUserGroupRequest): Promise<UserGroupResponse> {
  return apiFetch<UserGroupResponse>("/user-groups", { method: "POST", body: input });
}

/** Rename a group; `input` must carry at least one field (server enforces). */
export function updateUserGroup(
  id: number,
  input: UpdateUserGroupRequest,
): Promise<UserGroupResponse> {
  return apiFetch<UserGroupResponse>(`/user-groups/${id}`, { method: "PATCH", body: input });
}

/** Delete a group. Resolves on the server's `204`. */
export function deleteUserGroup(id: number): Promise<void> {
  return apiFetch<void>(`/user-groups/${id}`, { method: "DELETE" });
}

/** List the users that are members of `groupId`. */
export function listGroupMembers(groupId: number): Promise<UserResponse[]> {
  return apiFetch<UserResponse[]>(`/user-groups/${groupId}/members`);
}

/**
 * Add a user to a group (idempotent `PUT`). Resolves on the server's `204`; a
 * re-add of an existing member is a no-op server-side.
 */
export function addUserToGroup(groupId: number, userId: number): Promise<void> {
  return apiFetch<void>(`/user-groups/${groupId}/members/${userId}`, { method: "PUT" });
}

/** Remove a user from a group. Resolves on the server's `204`. */
export function removeUserFromGroup(groupId: number, userId: number): Promise<void> {
  return apiFetch<void>(`/user-groups/${groupId}/members/${userId}`, { method: "DELETE" });
}
