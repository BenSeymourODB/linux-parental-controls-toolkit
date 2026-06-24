/**
 * Read calls for the `UserGroup` policy entity (#124 contract).
 *
 * Same proven shape as the other `$lib/api/*` clients: thin typed wrappers over
 * {@link apiFetch}, with the response type imported from the shared `/api`
 * contract so the frontend never re-declares a DTO. A `UserGroup` is a named set
 * of users that group-targeted schedules/exceptions (#182) apply to.
 *
 * Only the **list** read is exposed here — it is what the group-schedule
 * reorder editor (#270) needs to populate its group picker. The full
 * user-groups admin CRUD/membership surface is its own slice (#124); add the
 * write wrappers there.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { UserGroupResponse } from "./contract.js";

/** List all user groups, in the order `/api` returns them. */
export function listUserGroups(): Promise<UserGroupResponse[]> {
  return apiFetch<UserGroupResponse[]>("/user-groups");
}
