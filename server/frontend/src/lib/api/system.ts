/**
 * System-status API calls for the admin surface (#39).
 *
 * Used by the first-run setup progress screen to poll the Ansible venv
 * bootstrap state until it reaches `ready` or `unavailable`, and by the
 * Dashboard's fleet-wide queue-summary widget (#322).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type { AnsibleVenvStatusResponse, QueueSummaryResponse } from "./contract.js";

/** Fetch the current Ansible venv bootstrap status from `GET /api/system/ansible`. */
export function fetchAnsibleStatus(): Promise<AnsibleVenvStatusResponse> {
  return apiFetch<AnsibleVenvStatusResponse>("/system/ansible");
}

/** Fetch the fleet-wide offline-queue summary from `GET /api/system/queue-summary` (#322). */
export function fetchQueueSummary(): Promise<QueueSummaryResponse> {
  return apiFetch<QueueSummaryResponse>("/system/queue-summary");
}
