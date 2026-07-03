/**
 * Client health probe (#81): report each enrolled client's reachability and the
 * health of its supervised components over the Phase-4 SSH facade.
 *
 * Layering: {@link ./components.ts} (the probe catalogue + `systemctl is-active`
 * classification) ← {@link ./prober.ts} (the `ClientProber` seam +
 * `SshClientProber`). The `api/clients` health service consumes the
 * {@link ClientProber} seam; the DTO derives its component enum from
 * {@link clientComponentValues}.
 */
export const moduleName = "transport/health";

export {
  activityWatchFailureDetail,
  AW_SERVER_PORT,
  CLIENT_COMPONENTS,
  classifyActivityWatchInfo,
  classifyServiceState,
  clientComponentValues,
  componentHealthStatusValues,
  systemdIsActiveArgv,
  type ActivityWatchRestProbe,
  type ClientComponent,
  type ComponentClassification,
  type ComponentDescriptor,
  type ComponentHealthStatus,
  type ComponentProbe,
  type DeferredProbe,
  type SystemServiceProbe,
} from "./components.js";

export {
  SshClientProber,
  clientReachabilityValues,
  type ActivityWatchInfoProbe,
  type ClientProber,
  type ClientProbeResult,
  type ClientReachability,
  type ComponentHealthResult,
  type HealthProbeTransport,
  type SshClientProberOptions,
} from "./prober.js";
