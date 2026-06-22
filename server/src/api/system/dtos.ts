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
