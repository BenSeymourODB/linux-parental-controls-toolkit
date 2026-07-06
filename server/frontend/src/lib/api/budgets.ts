/**
 * CRUD calls for the `Budget` policy entity (#51 contract, #189 editor).
 *
 * Same proven shape as `$lib/api/activities` (#53/#189): thin typed wrappers
 * over {@link apiFetch}, with the request/response types imported from the
 * shared `/api` contract so the frontend never re-declares a DTO. A `Budget`
 * grants a user `secondsAllowed` of time per rollover `window` (daily / weekly
 * / monthly) for a given `scope` (`overall`, a single `activity`, or an
 * activity `group`); `targetId` is the referent for the non-`overall` scopes.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  BudgetResponse,
  CreateBudgetRequest,
  ResolvedBudgetResponse,
  UpdateBudgetRequest,
} from "./contract.js";

/**
 * List budgets. With `userId` the server restricts to that user; without it,
 * every budget is returned (the `?userId=` filter the route exposes).
 */
export function listBudgets(userId?: number): Promise<BudgetResponse[]> {
  const path = userId === undefined ? "/budgets" : `/budgets?userId=${userId}`;
  return apiFetch<BudgetResponse[]>(path);
}

/** Create a budget; the server validates target coherence and returns the row. */
export function createBudget(input: CreateBudgetRequest): Promise<BudgetResponse> {
  return apiFetch<BudgetResponse>("/budgets", { method: "POST", body: input });
}

/** Patch a budget; `input` must carry at least one field (server enforces). */
export function updateBudget(id: number, input: UpdateBudgetRequest): Promise<BudgetResponse> {
  return apiFetch<BudgetResponse>(`/budgets/${id}`, { method: "PATCH", body: input });
}

/** Delete a budget. Resolves on the server's `204`. */
export function deleteBudget(id: number): Promise<void> {
  return apiFetch<void>(`/budgets/${id}`, { method: "DELETE" });
}

/**
 * The user's effective budget baseline per slot, each tagged with whether it is
 * the user's own budget or inherited from a group (#363). Display-only: the
 * server resolves own-wins / lowest-group-id precedence (`gatherUserBudgets`),
 * this just reads the result so the editor can mark local vs inherited slots.
 */
export function listResolvedBudgets(userId: number): Promise<ResolvedBudgetResponse[]> {
  return apiFetch<ResolvedBudgetResponse[]>(`/users/${userId}/budgets/resolved`);
}
