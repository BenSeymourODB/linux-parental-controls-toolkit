/**
 * System-status API calls for the admin surface (#39, #96).
 *
 * Used by the first-run setup progress screen to poll the Ansible venv
 * bootstrap state until it reaches `ready` or `unavailable`, by the Dashboard
 * system-status strip (#321, #96) to show at-a-glance service health, and by
 * the Dashboard's fleet-wide queue-summary widget (#322).
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  AdGuardManagedStatusResponse,
  AnsibleVenvStatusResponse,
  QueueSummaryResponse,
} from "./contract.js";

/** Fetch the current Ansible venv bootstrap status from `GET /api/system/ansible`. */
export function fetchAnsibleStatus(): Promise<AnsibleVenvStatusResponse> {
  return apiFetch<AnsibleVenvStatusResponse>("/system/ansible");
}

/**
 * Fetch the managed AdGuard Home process status from
 * `GET /api/system/adguard-managed`. When `PCT_ADGUARD_MODE` is not `managed`
 * the response collapses to `{ enabled: false, … }`.
 */
export function fetchAdGuardManagedStatus(): Promise<AdGuardManagedStatusResponse> {
  return apiFetch<AdGuardManagedStatusResponse>("/system/adguard-managed");
}

/** Fetch the fleet-wide offline-queue summary from `GET /api/system/queue-summary` (#322). */
export function fetchQueueSummary(): Promise<QueueSummaryResponse> {
  return apiFetch<QueueSummaryResponse>("/system/queue-summary");
}
