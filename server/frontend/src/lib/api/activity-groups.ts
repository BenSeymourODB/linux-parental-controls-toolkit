/**
 * CRUD + membership calls for the `ActivityGroup` policy entity (#51 contract,
 * #189 editor).
 *
 * Same proven shape as `$lib/api/activities` (#53/#189): thin typed wrappers
 * over {@link apiFetch}, with the request/response types imported from the
 * shared `/api` contract so the frontend never re-declares a DTO. An
 * `ActivityGroup` is a named bundle of {@link ActivityResponse} rows that a
 * budget/schedule can target with scope `group`; the membership endpoints
 * attach/detach individual activities.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  ActivityGroupResponse,
  ActivityResponse,
  CreateActivityGroupRequest,
  UpdateActivityGroupRequest,
} from "./contract.js";

/** List all activity groups, in the order `/api` returns them. */
export function listActivityGroups(): Promise<ActivityGroupResponse[]> {
  return apiFetch<ActivityGroupResponse[]>("/activity-groups");
}

/** Create a group; the server validates `name` (unique) and returns the row. */
export function createActivityGroup(
  input: CreateActivityGroupRequest,
): Promise<ActivityGroupResponse> {
  return apiFetch<ActivityGroupResponse>("/activity-groups", { method: "POST", body: input });
}

/** Rename a group; `input` must carry at least one field (server enforces). */
export function updateActivityGroup(
  id: number,
  input: UpdateActivityGroupRequest,
): Promise<ActivityGroupResponse> {
  return apiFetch<ActivityGroupResponse>(`/activity-groups/${id}`, { method: "PATCH", body: input });
}

/** Delete a group. Resolves on the server's `204`. */
export function deleteActivityGroup(id: number): Promise<void> {
  return apiFetch<void>(`/activity-groups/${id}`, { method: "DELETE" });
}

/** List the activities that are members of `groupId`. */
export function listGroupActivities(groupId: number): Promise<ActivityResponse[]> {
  return apiFetch<ActivityResponse[]>(`/activity-groups/${groupId}/activities`);
}

/**
 * Add an activity to a group (idempotent `PUT`). Resolves on the server's
 * `204`; a re-add of an existing member is a no-op server-side.
 */
export function addActivityToGroup(groupId: number, activityId: number): Promise<void> {
  return apiFetch<void>(`/activity-groups/${groupId}/activities/${activityId}`, { method: "PUT" });
}

/** Remove an activity from a group. Resolves on the server's `204`. */
export function removeActivityFromGroup(groupId: number, activityId: number): Promise<void> {
  return apiFetch<void>(`/activity-groups/${groupId}/activities/${activityId}`, {
    method: "DELETE",
  });
}
