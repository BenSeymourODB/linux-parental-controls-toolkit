/**
 * CRUD calls for the `User` policy entity (#51 contract, consumed by #53).
 *
 * This is the proven shape the deferred editors (clients, activities/groups,
 * budgets, schedules) repeat: thin typed wrappers over {@link apiFetch}, with
 * the request/response types imported from the shared `/api` contract so the
 * frontend never re-declares a DTO.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { CreateUserRequest, UpdateUserRequest, UserResponse } from "./contract.js";

/** List all supervised users, newest-or-server-order as returned by `/api`. */
export function listUsers(): Promise<UserResponse[]> {
  return apiFetch<UserResponse[]>("/users");
}

/** Create a user; the server validates `displayName`/`tz` and returns the row. */
export function createUser(input: CreateUserRequest): Promise<UserResponse> {
  return apiFetch<UserResponse>("/users", { method: "POST", body: input });
}

/** Patch a user; `input` must carry at least one field (server enforces). */
export function updateUser(id: number, input: UpdateUserRequest): Promise<UserResponse> {
  return apiFetch<UserResponse>(`/users/${id}`, { method: "PATCH", body: input });
}

/** Delete a user. Resolves on the server's `204`. */
export function deleteUser(id: number): Promise<void> {
  return apiFetch<void>(`/users/${id}`, { method: "DELETE" });
}
