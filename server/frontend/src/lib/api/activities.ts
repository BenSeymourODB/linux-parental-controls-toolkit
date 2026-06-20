/**
 * CRUD calls for the `Activity` policy entity (#51 contract, #189 editor).
 *
 * Same proven shape as `$lib/api/users` (#53): thin typed wrappers over
 * {@link apiFetch}, with the request/response types imported from the shared
 * `/api` contract so the frontend never re-declares a DTO. An `Activity` is a
 * matcher (`kind` + `matcher`) that budgets/schedules can target.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  ActivityResponse,
  CreateActivityRequest,
  UpdateActivityRequest,
} from "./contract.js";

/** List all activities, in the order `/api` returns them. */
export function listActivities(): Promise<ActivityResponse[]> {
  return apiFetch<ActivityResponse[]>("/activities");
}

/** Create an activity; the server validates `kind`/`matcher` and returns the row. */
export function createActivity(input: CreateActivityRequest): Promise<ActivityResponse> {
  return apiFetch<ActivityResponse>("/activities", { method: "POST", body: input });
}

/** Patch an activity; `input` must carry at least one field (server enforces). */
export function updateActivity(id: number, input: UpdateActivityRequest): Promise<ActivityResponse> {
  return apiFetch<ActivityResponse>(`/activities/${id}`, { method: "PATCH", body: input });
}

/** Delete an activity. Resolves on the server's `204`. */
export function deleteActivity(id: number): Promise<void> {
  return apiFetch<void>(`/activities/${id}`, { method: "DELETE" });
}
