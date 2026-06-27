/**
 * The save-and-push **preview** call (#64 backend, #281 rendering).
 *
 * A thin typed wrapper over {@link apiFetch}, mirroring `$lib/api/budgets`:
 * the request/response types are imported from the shared `/api` contract so
 * the frontend never re-declares a DTO. The endpoint is **side-effect-free** —
 * it resolves the user's *current* persisted overall policy and the *proposed*
 * policy in the body through the Phase-4 resolver, diffs the two, and returns
 * the human-readable change set plus the clients the push would reach (each
 * annotated with last-seen + pending-queue depth). It never probes, pushes, or
 * writes the queue.
 *
 * The body reuses the same `BudgetResponse` / `ScheduleResponse` rows the editor
 * already holds (the contract's note: "no parallel wire shape"), so a caller
 * passes the proposed policy as-is.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { PolicyPreviewRequest, PolicyPreviewResponse } from "./contract.js";

/**
 * Preview the save-and-push diff for `userId` against a `proposed` policy.
 *
 * Resolves to the change set + affected clients; throws {@link ApiError} on a
 * non-2xx response (e.g. `404` when the user does not exist).
 */
export function previewPolicyPush(
  userId: number,
  proposed: PolicyPreviewRequest,
): Promise<PolicyPreviewResponse> {
  return apiFetch<PolicyPreviewResponse>(`/users/${userId}/policy-preview`, {
    method: "POST",
    body: proposed,
  });
}
