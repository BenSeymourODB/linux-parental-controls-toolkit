/**
 * System-status API calls for the admin surface (#39).
 *
 * Used by the first-run setup progress screen to poll the Ansible venv
 * bootstrap state until it reaches `ready` or `unavailable`.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { AnsibleVenvStatusResponse } from "./contract.js";

/** Fetch the current Ansible venv bootstrap status from `GET /api/system/ansible`. */
export function fetchAnsibleStatus(): Promise<AnsibleVenvStatusResponse> {
  return apiFetch<AnsibleVenvStatusResponse>("/system/ansible");
}
