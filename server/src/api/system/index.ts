/** System-status API (#39): read-only first-run subsystem health. */
export const moduleName = "api/system";

export {
  ansibleVenvStateSchema,
  ansibleVenvStatusResponseSchema,
  toAnsibleVenvStatusResponse,
  type AnsibleVenvStatusResponse,
} from "./dtos.js";
export { registerSystemRoutes } from "./routes.js";
