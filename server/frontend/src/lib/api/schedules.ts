/**
 * CRUD calls for the `Schedule` policy entity (#51 contract, #189 editor).
 *
 * Same proven shape as `$lib/api/budgets` (#53/#189): thin typed wrappers over
 * {@link apiFetch}, with request/response types imported from the shared `/api`
 * contract so the frontend never re-declares a DTO. A `Schedule` is a recurring
 * rule that `allow`/`deny`/`extend`s a `targetKind` (`overall`, an `activity`,
 * or an activity `group`) for a user. The recurrence + ordinal fields exist on
 * the contract but are authored elsewhere: day-of-week / intra-day windows are
 * #140 and drag-reorder is #63, so this editor creates the always-on degenerate
 * rule and the wrappers stay a faithful pass-through of whatever the contract
 * carries.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  ScheduleResponse,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  ScheduleOrderView,
  GroupScheduleResponse,
  CreateGroupScheduleRequest,
  GroupScheduleOrderView,
} from "./contract.js";

/**
 * List schedules. With `userId` the server restricts to that user; without it,
 * every schedule is returned (the `?userId=` filter the route exposes).
 */
export function listSchedules(userId?: number): Promise<ScheduleResponse[]> {
  const path = userId === undefined ? "/schedules" : `/schedules?userId=${userId}`;
  return apiFetch<ScheduleResponse[]>(path);
}

/** Create a schedule; the server validates target coherence and returns the row. */
export function createSchedule(input: CreateScheduleRequest): Promise<ScheduleResponse> {
  return apiFetch<ScheduleResponse>("/schedules", { method: "POST", body: input });
}

/** Patch a schedule; `input` must carry at least one field (server enforces). */
export function updateSchedule(
  id: number,
  input: UpdateScheduleRequest,
): Promise<ScheduleResponse> {
  return apiFetch<ScheduleResponse>(`/schedules/${id}`, { method: "PATCH", body: input });
}

/** Delete a schedule. Resolves on the server's `204`. */
export function deleteSchedule(id: number): Promise<void> {
  return apiFetch<void>(`/schedules/${id}`, { method: "DELETE" });
}

/**
 * Fetch a user's schedules in evaluation order, plus the editor's derived facts
 * (#63): which rules are shadowed and which are in effect right now. Precedence
 * is computed server-side, so the editor renders these without re-deriving them.
 */
export function getScheduleOrder(userId: number): Promise<ScheduleOrderView> {
  return apiFetch<ScheduleOrderView>(`/users/${userId}/schedules/order`);
}

/**
 * Persist a new evaluation order for a user's schedules. `orderedIds` must be a
 * permutation of exactly that user's schedule ids (the server returns a 409
 * otherwise); the refreshed order view comes back.
 */
export function reorderSchedules(
  userId: number,
  orderedIds: number[],
): Promise<ScheduleOrderView> {
  return apiFetch<ScheduleOrderView>(`/users/${userId}/schedules/order`, {
    method: "PUT",
    body: { orderedIds },
  });
}

/**
 * Fetch a group's schedules in evaluation order, plus the editor's structural
 * shadow findings (#270). Unlike the user order view there is no "in effect
 * now" — a group has no single timezone, so a live instant is resolved per
 * member, not for the group. Precedence/shadowing is computed server-side.
 */
export function getGroupScheduleOrder(groupId: number): Promise<GroupScheduleOrderView> {
  return apiFetch<GroupScheduleOrderView>(`/user-groups/${groupId}/schedules/order`);
}

/**
 * Persist a new evaluation order for a group's schedules. `orderedIds` must be a
 * permutation of exactly that group's schedule ids (the server returns a 409
 * otherwise); the refreshed order view comes back.
 */
export function reorderGroupSchedules(
  groupId: number,
  orderedIds: number[],
): Promise<GroupScheduleOrderView> {
  return apiFetch<GroupScheduleOrderView>(`/user-groups/${groupId}/schedules/order`, {
    method: "PUT",
    body: { orderedIds },
  });
}

/** Create a group schedule; the server validates target coherence, returns the row. */
export function createGroupSchedule(
  groupId: number,
  input: CreateGroupScheduleRequest,
): Promise<GroupScheduleResponse> {
  return apiFetch<GroupScheduleResponse>(`/user-groups/${groupId}/schedules`, {
    method: "POST",
    body: input,
  });
}

/**
 * Patch a group schedule (flat by id, like `/group-schedules/:id`); `input` must
 * carry at least one field (the server enforces). Reuses the user schedule PATCH
 * body — the group rule shape is identical minus its owner.
 */
export function updateGroupSchedule(
  id: number,
  input: UpdateScheduleRequest,
): Promise<GroupScheduleResponse> {
  return apiFetch<GroupScheduleResponse>(`/group-schedules/${id}`, { method: "PATCH", body: input });
}

/** Delete a group schedule. Resolves on the server's `204`. */
export function deleteGroupSchedule(id: number): Promise<void> {
  return apiFetch<void>(`/group-schedules/${id}`, { method: "DELETE" });
}
