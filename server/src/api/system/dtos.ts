/**
 * zod DTO for the system-status read API (#39), shared with the frontend (the
 * single `/api/*` contract). Read-only — these are runtime facts, not a
 * request-mutable resource — so there is no write DTO.
 *
 * The Ansible block mirrors {@link AnsibleVenvStatus} from `setup/ansible-venv`;
 * the mapper {@link toAnsibleVenvStatusResponse} is the single conversion point,
 * and its return type makes the transport-side `AnsibleVenvState` enum and the
 * schema here a compile-time drift guard — they cannot diverge silently.
 */
import { z } from "zod";

import type { AnsibleVenvStatus } from "../../setup/ansible-venv.js";
import type { AdGuardManagedStatus } from "../../transport/adguard/index.js";
import type { QueueSummary } from "../../transport/queue/index.js";

/** Lifecycle state of the first-run Ansible venv bootstrap. */
export const ansibleVenvStateSchema = z.enum(["idle", "bootstrapping", "ready", "unavailable"]);

/** Response shape of `GET /api/system/ansible`. */
export const ansibleVenvStatusResponseSchema = z.object({
  state: ansibleVenvStateSchema,
  binaryPath: z.string(),
  playbooksDir: z.string(),
  coreVersion: z.string(),
  checkedAt: z.string().nullable(),
  detail: z.string().nullable(),
});

/** The inferred `GET /api/system/ansible` response type, shared with the frontend. */
export type AnsibleVenvStatusResponse = z.infer<typeof ansibleVenvStatusResponseSchema>;

/** Map the setup-layer {@link AnsibleVenvStatus} snapshot onto the wire contract. */
export function toAnsibleVenvStatusResponse(status: AnsibleVenvStatus): AnsibleVenvStatusResponse {
  return {
    state: status.state,
    binaryPath: status.binaryPath,
    playbooksDir: status.playbooksDir,
    coreVersion: status.coreVersion,
    checkedAt: status.checkedAt,
    detail: status.detail,
  };
}

/** Lifecycle state of the managed AdGuard Home process (#96). */
export const adGuardManagedStateSchema = z.enum([
  "idle",
  "fetching",
  "starting",
  "running",
  "stopped",
  "failed",
]);

/**
 * Response shape of `GET /api/system/adguard-managed`.
 *
 * `enabled` is `true` only when `PCT_ADGUARD_MODE=managed`; in every other mode
 * there is no supervised process and the remaining fields are `null`. The
 * non-null branch mirrors {@link AdGuardManagedStatus}, and
 * {@link toAdGuardManagedStatusResponse} is the single conversion point, so the
 * transport-side enum and this schema cannot drift silently.
 */
export const adGuardManagedStatusResponseSchema = z.object({
  enabled: z.boolean(),
  state: adGuardManagedStateSchema.nullable(),
  binaryPath: z.string().nullable(),
  version: z.string().nullable(),
  adminEndpoint: z.string().nullable(),
  restarts: z.number().nullable(),
  checkedAt: z.string().nullable(),
  detail: z.string().nullable(),
});

/** The inferred `GET /api/system/adguard-managed` response type, shared with the frontend. */
export type AdGuardManagedStatusResponse = z.infer<typeof adGuardManagedStatusResponseSchema>;

/**
 * Map the managed-supervisor snapshot onto the wire contract. `null` (managed
 * mode not enabled) collapses to `enabled: false` with null fields.
 */
export function toAdGuardManagedStatusResponse(
  status: AdGuardManagedStatus | null,
): AdGuardManagedStatusResponse {
  if (status === null) {
    return {
      enabled: false,
      state: null,
      binaryPath: null,
      version: null,
      adminEndpoint: null,
      restarts: null,
      checkedAt: null,
      detail: null,
    };
  }
  return {
    enabled: true,
    state: status.state,
    binaryPath: status.binaryPath,
    version: status.version,
    adminEndpoint: status.adminEndpoint,
    restarts: status.restarts,
    checkedAt: status.checkedAt,
    detail: status.detail,
  };
}

/**
 * Response shape of `GET /api/system/queue-summary` (#322): fleet-wide offline
 * transport-queue rollup. `oldestPendingAt` is the ISO timestamp of the oldest
 * still-`pending` action, or `null` when nothing is pending. Read-only runtime
 * facts, so there is no write DTO.
 */
export const queueSummaryResponseSchema = z.object({
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  oldestPendingAt: z.string().nullable(),
});

/** The inferred `GET /api/system/queue-summary` response type, shared with the frontend. */
export type QueueSummaryResponse = z.infer<typeof queueSummaryResponseSchema>;

/**
 * Map the queue-layer {@link QueueSummary} snapshot onto the wire contract —
 * the single conversion point, serialising the `Date` anchor to an ISO string.
 */
export function toQueueSummaryResponse(summary: QueueSummary): QueueSummaryResponse {
  return {
    pending: summary.pending,
    failed: summary.failed,
    oldestPendingAt: summary.oldestPendingAt?.toISOString() ?? null,
  };
}
