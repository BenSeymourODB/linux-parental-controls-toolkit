/** System-status API (#39): read-only first-run subsystem health. */
export const moduleName = "api/system";

export {
  ansibleVenvStateSchema,
  ansibleVenvStatusResponseSchema,
  toAnsibleVenvStatusResponse,
  type AnsibleVenvStatusResponse,
  adGuardManagedStateSchema,
  adGuardManagedStatusResponseSchema,
  toAdGuardManagedStatusResponse,
  type AdGuardManagedStatusResponse,
} from "./dtos.js";
export { registerSystemRoutes } from "./routes.js";
