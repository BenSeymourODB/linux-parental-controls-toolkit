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
  AdGuardConfigError,
} from "./errors.js";
export {
  resolveAdGuardAuth,
  type ReadSecretFile,
  type ResolveAdGuardAuthDeps,
  type ExternalAdGuardSettings,
} from "./secrets.js";
export {
  AdGuardService,
  createAdGuardService,
  type AdGuardServiceDeps,
  type DnsHealth,
  type DnsMode,
  type DnsStatus,
  type ManagedInstanceSource,
  type PreflightLogger,
} from "./service.js";
export {
  startAdGuardHealthPoll,
  ADGUARD_HEALTH_LOG_COMPONENT,
  DEFAULT_ADGUARD_HEALTH_POLL_PATTERN,
  type AdGuardHealthPollHandle,
  type AdGuardHealthPollOptions,
  type PollableAdGuardService,
} from "./health-poller.js";
export {
  AdGuardManagedSupervisor,
  createAdGuardManagedSupervisor,
  type AdGuardManagedConfig,
  type AdGuardManagedDeps,
  type AdGuardManagedLogger,
  type AdGuardManagedState,
  type AdGuardManagedStatus,
  type ManagedProcess,
  type SpawnManaged,
} from "./supervisor.js";
export {
  acquireAdGuardHome,
  AdGuardChecksumError,
  AdGuardDownloadError,
  type AcquireConfig,
  type AcquireResult,
} from "./acquire.js";
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
