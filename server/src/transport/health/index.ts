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

// The reachability-failure taxonomy (#353) lives with the SSH error it
// annotates; re-exported here so the health DTO derives its enum from a single
// source, the same discipline as the component / reachability enums above.
export { sshUnreachableReasonValues, type SshUnreachableReason } from "../ssh/errors.js";

// Post-enrol connectivity verification (#354): the classified server→client SSH
// self-test the installer triggers, distinct from the passive-liveness prober
// above. Shares the SSH facade + the #353 failure classification.
export {
  SshClientConnectionVerifier,
  type ClientConnectionVerifier,
  type ConnectionVerification,
  type SshClientConnectionVerifierOptions,
  type VerifyLogger,
  type VerifyTransport,
} from "./verifier.js";
