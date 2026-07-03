/**
 * `ClientProber` — the per-client health probe (#81).
 *
 * Given an enrolled {@link clients} row, it reports the client's **reachability**
 * and the health of each component in the {@link CLIENT_COMPONENTS} catalogue.
 * `SshClientProber` does this over the Phase-4 SSH facade (the same pooled
 * transport the timekpra commands and the telemetry pull reuse), running each
 * system-service probe as an unprivileged `systemctl is-active <unit>`
 * subprocess and classifying its stdout.
 *
 * Like the offline-queue (#84) and the telemetry pull (#86), this is built
 * against an **injected SSH seam** so it is unit-testable without a live client;
 * the concrete wiring (the dashboard's SSH private key) is plumbed by the
 * first-run SSH-key bootstrap (#39).
 *
 * License boundary: none touched — the prober only *execs* `systemctl` over the
 * existing SSH subprocess facade; no GPL code is linked in-process and no
 * REST/subprocess boundary is collapsed.
 */
import type { ClientRow } from "../../policy/repository.js";
import { ActivityWatchClient } from "../activitywatch/client.js";
import type { AwServerInfo } from "../activitywatch/schemas.js";
import { SshError } from "../ssh/errors.js";
import {
  targetFromClient,
  type ExecOptions,
  type ExecResult,
  type PortForwardOptions,
  type PortForwardTarget,
  type SshCredentials,
  type SshTarget,
} from "../ssh/facade.js";
import {
  activityWatchFailureDetail,
  classifyActivityWatchInfo,
  classifyServiceState,
  CLIENT_COMPONENTS,
  systemdIsActiveArgv,
  type ActivityWatchRestProbe,
  type ClientComponent,
  type ComponentClassification,
  type ComponentHealthStatus,
} from "./components.js";

/** Whether a client answered an SSH probe right now. */
export const clientReachabilityValues = ["online", "offline", "unknown"] as const;

/** `online` (probe succeeded), `offline` (SSH unreachable), `unknown` (not probed). */
export type ClientReachability = (typeof clientReachabilityValues)[number];

/** Health verdict for one component from a single probe pass. */
export interface ComponentHealthResult {
  readonly component: ClientComponent;
  readonly status: ComponentHealthStatus;
  /** Human-readable detail (the systemd state, the deferral reason, …). */
  readonly detail: string;
}

/** The outcome of probing one client. */
export interface ClientProbeResult {
  readonly reachability: ClientReachability;
  /** When the probe ran (drives the `last_seen` bump on a reachable client). */
  readonly at: Date;
  readonly components: readonly ComponentHealthResult[];
}

/**
 * Probes one client's reachability + component health. Injected into the health
 * service so the route is testable without SSH and so the live SSH wiring can
 * be supplied (or withheld, pre-#39) at bootstrap.
 */
export interface ClientProber {
  probe(client: Pick<ClientRow, "hostname" | "sshUser">): Promise<ClientProbeResult>;
}

/**
 * The slice of the SSH transport the prober needs: an *unchecked* `exec`
 * (a non-zero `systemctl is-active` is data, not an error) for the system
 * services, and `withPortForward` for the loopback ActivityWatch REST probe
 * (#323). Declared structurally so the real {@link SshTransport} satisfies it
 * and tests can pass a lightweight fake without an `as` cast — same pattern as
 * `TimekprTransport`.
 */
export interface HealthProbeTransport {
  exec(target: SshTarget, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  withPortForward<T>(
    target: SshTarget,
    remote: PortForwardTarget,
    fn: (local: { host: string; port: number }) => Promise<T>,
    options?: PortForwardOptions,
  ): Promise<T>;
}

/** Reach a tunnelled `aw-server` at `baseUrl` and return its `/api/0/info`. */
export type ActivityWatchInfoProbe = (baseUrl: string) => Promise<AwServerInfo>;

/** Construction options for {@link SshClientProber}. */
export interface SshClientProberOptions {
  /** Per-exec overrides (e.g. a tighter `timeoutMs`) forwarded to the transport. */
  readonly execOptions?: ExecOptions;
  /** Clock for `result.at`; overridable in tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * How the ActivityWatch probe reaches the tunnelled `aw-server`. Defaults to
   * a REST-only {@link ActivityWatchClient} `getInfo()`; injectable so unit
   * tests exercise the verdict mapping without a live `fetch`.
   */
  readonly probeActivityWatch?: ActivityWatchInfoProbe;
}

/** Every component reported `unknown` with one shared detail (used when offline). */
function allUnknown(detail: string): ComponentHealthResult[] {
  return CLIENT_COMPONENTS.map((descriptor) => ({
    component: descriptor.component,
    status: "unknown" as const,
    detail,
  }));
}

/**
 * Probes enrolled clients over the SSH facade. One instance is shared across
 * the dashboard (it reuses the transport's connection pool).
 */
export class SshClientProber implements ClientProber {
  readonly #transport: HealthProbeTransport;
  readonly #credentials: SshCredentials;
  readonly #execOptions: ExecOptions | undefined;
  readonly #now: () => Date;
  readonly #probeActivityWatch: ActivityWatchInfoProbe;

  /**
   * @param transport the SSH transport (or a structural stand-in) to probe over.
   * @param credentials the dashboard's SSH key material (from #39's bootstrap).
   * @param options per-exec overrides, an injectable clock, and the AW probe.
   */
  constructor(
    transport: HealthProbeTransport,
    credentials: SshCredentials,
    options: SshClientProberOptions = {},
  ) {
    this.#transport = transport;
    this.#credentials = credentials;
    this.#execOptions = options.execOptions;
    this.#now = options.now ?? ((): Date => new Date());
    this.#probeActivityWatch =
      options.probeActivityWatch ??
      ((baseUrl): Promise<AwServerInfo> => new ActivityWatchClient({ baseUrl }).getInfo());
  }

  async probe(client: Pick<ClientRow, "hostname" | "sshUser">): Promise<ClientProbeResult> {
    const target = targetFromClient(client, this.#credentials);
    const at = this.#now();
    const components: ComponentHealthResult[] = [];

    for (const { component, probe } of CLIENT_COMPONENTS) {
      if (probe.method === "deferred") {
        components.push({ component, status: "unknown", detail: probe.detail });
        continue;
      }
      try {
        const verdict =
          probe.method === "systemd-system"
            ? classifyServiceState(
                (
                  await this.#transport.exec(
                    target,
                    systemdIsActiveArgv(probe.unit),
                    this.#execOptions,
                  )
                ).stdout,
              )
            : await this.#probeAwComponent(target, probe);
        components.push({ component, status: verdict.status, detail: verdict.detail });
      } catch (error) {
        // A component probe only rejects with the SSH error taxonomy at the
        // transport layer (`exec` unreachable/timed out; `withPortForward`
        // failing to open the tunnel). Any of these means the box stopped
        // answering mid-probe, so the whole client is offline. A non-`SshError`
        // is an unexpected bug and must surface, not masquerade as "offline".
        // (An `aw-server`-level failure over a *working* tunnel never reaches
        // here — it is classified `unhealthy` in `#probeAwComponent`.)
        if (error instanceof SshError) {
          return { reachability: "offline", at, components: allUnknown("host unreachable") };
        }
        throw error;
      }
    }

    return { reachability: "online", at, components };
  }

  /**
   * Probe the loopback `aw-server` over a port-forward and classify the result.
   * The tunnel is torn down by the facade the moment `getInfo()` settles.
   *
   * An {@link ActivityWatchClient} failure means the tunnel opened but
   * `aw-server` didn't answer usefully → `unhealthy`. An `SshError` (the tunnel
   * itself failed to open) or any other error is rethrown for the caller to map
   * to client-offline / surface as a bug — the SSH layer's reachability is not
   * duplicated here.
   */
  async #probeAwComponent(
    target: SshTarget,
    probe: ActivityWatchRestProbe,
  ): Promise<ComponentClassification> {
    try {
      const info = await this.#transport.withPortForward(target, { port: probe.port }, (local) =>
        this.#probeActivityWatch(`http://${local.host}:${local.port}`),
      );
      return classifyActivityWatchInfo(info);
    } catch (error) {
      const detail = activityWatchFailureDetail(error);
      if (detail !== undefined) return { status: "unhealthy", detail };
      throw error;
    }
  }
}
