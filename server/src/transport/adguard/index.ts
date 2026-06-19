/** AdGuard Home transport: REST client (managed sidecar or external instance). */
export const moduleName = "transport/adguard";

export {
  AdGuardHomeClient,
  DEFAULT_CLIENT_PREFIX,
  type AdGuardAuth,
  type AdGuardClientOptions,
  type FetchLike,
} from "./client.js";
export {
  AdGuardError,
  AdGuardUnreachableError,
  AdGuardRequestError,
  AdGuardAuthError,
  AdGuardParseError,
  AdGuardScopeError,
} from "./errors.js";
export {
  adGuardClientSchema,
  adGuardClientsResponseSchema,
  adGuardFilteringStatusSchema,
  adGuardStatusSchema,
  type AdGuardClient,
  type AdGuardClientInput,
  type AdGuardClientsResponse,
  type AdGuardFilteringStatus,
  type AdGuardStatus,
} from "./schemas.js";
