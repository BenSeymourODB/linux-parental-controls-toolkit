/**
 * Per-user `NotificationPolicy` calls (#104 contract, #105 editor).
 *
 * Same thin-wrapper shape as `$lib/api/budgets`: typed calls over
 * {@link apiFetch}, with the request/response types imported from the shared
 * `/api` contract so the frontend never re-declares a DTO. A notification
 * policy is 1:1 with a user and controls the supervised-user notification
 * experience (`docs/client-notifications.md`): the master `enabled` switch, the
 * `soundProfile`, the `graceSeconds` countdown, and optional per-budget
 * `cadenceOverrides`.
 *
 * Every user always *has* an effective policy: `getNotificationPolicy` returns
 * the persisted row or the documented defaults, `upsertNotificationPolicy`
 * customises it, and `deleteNotificationPolicy` reverts to defaults.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { NotificationPolicyResponse, UpsertNotificationPolicyRequest } from "./contract.js";

/**
 * Read a user's effective notification policy. The server always returns a
 * policy — the persisted row, or the documented defaults when none is stored.
 */
export function getNotificationPolicy(userId: number): Promise<NotificationPolicyResponse> {
  return apiFetch<NotificationPolicyResponse>(`/users/${userId}/notification-policy`);
}

/**
 * Upsert a user's notification policy. `input` is a partial body (at least one
 * field); omitted fields take the documented default on first write or are left
 * unchanged on a later write. Returns the resulting effective policy.
 */
export function upsertNotificationPolicy(
  userId: number,
  input: UpsertNotificationPolicyRequest,
): Promise<NotificationPolicyResponse> {
  return apiFetch<NotificationPolicyResponse>(`/users/${userId}/notification-policy`, {
    method: "PUT",
    body: input,
  });
}

/**
 * Revert a user to the documented default notification policy. Resolves on the
 * server's `204`; the server returns `404` when the user is already at defaults.
 */
export function deleteNotificationPolicy(userId: number): Promise<void> {
  return apiFetch<void>(`/users/${userId}/notification-policy`, { method: "DELETE" });
}
