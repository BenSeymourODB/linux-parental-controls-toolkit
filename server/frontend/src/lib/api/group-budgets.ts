/**
 * CRUD calls for group-targeted `Budget` rules (#134 backend, #363 editor).
 *
 * Same thin-wrapper shape as `$lib/api/budgets` (#189): a `GroupBudget` grants
 * every member of a {@link import("./contract.js").UserGroupResponse} an
 * allowance for a slot, inherited by members unless the member's own budget
 * overrides it (`gatherUserBudgets`, ADR 0008). Note the API asymmetry mirrored
 * here: **create is nested** under the group; **update / delete are flat by id**
 * — and the update reuses the plain-budget `UpdateBudgetRequest` (the server has
 * no separate group-update schema).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  CreateGroupBudgetRequest,
  GroupBudgetResponse,
  UpdateBudgetRequest,
} from "./contract.js";

/** List a group's budgets, in the order `/api` returns them. */
export function listGroupBudgets(groupId: number): Promise<GroupBudgetResponse[]> {
  return apiFetch<GroupBudgetResponse[]>(`/user-groups/${groupId}/budgets`);
}

/** Create a budget on `groupId`; the server validates target coherence. */
export function createGroupBudget(
  groupId: number,
  input: CreateGroupBudgetRequest,
): Promise<GroupBudgetResponse> {
  return apiFetch<GroupBudgetResponse>(`/user-groups/${groupId}/budgets`, {
    method: "POST",
    body: input,
  });
}

/** Update a group budget's window + allowance (scope/target are fixed at create). */
export function updateGroupBudget(
  id: number,
  input: UpdateBudgetRequest,
): Promise<GroupBudgetResponse> {
  return apiFetch<GroupBudgetResponse>(`/group-budgets/${id}`, { method: "PATCH", body: input });
}

/** Delete a group budget. Resolves on the server's `204`. */
export function deleteGroupBudget(id: number): Promise<void> {
  return apiFetch<void>(`/group-budgets/${id}`, { method: "DELETE" });
}
