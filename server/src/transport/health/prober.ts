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
import {
  SshError,
  SshExecTimeoutError,
  SshUnreachableError,
  type SshUnreachableReason,
} from "../ssh/errors.js";
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
  /**
   * When `reachability === "offline"`, the classified SSH failure cause (#353)
   * so the admin sees DNS vs refused vs timeout vs auth rather than one
   * catch-all string. `null` when the client is online or was never probed.
   */
  readonly reachabilityReason: SshUnreachableReason | null;
}

/**
 * Probes one client's reachability + component health. Injected into the health
 * service so the route is testable without SSH and so the live SSH wiring can
 * be supplied (or withheld, pre-#39) at bootstrap.
 */
export interface ClientProber {
  /**
   * `id` is optional so a caller can probe by address alone, but when supplied
   * it is included in the per-failure log line (#353) — the health service
   * passes the full client row so `clientId` is logged in production.
   */
  probe(
    client: Pick<ClientRow, "hostname" | "sshUser" | "sshTarget"> & { readonly id?: number },
  ): Promise<ClientProbeResult>;
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

/**
 * The slice of a structured logger the prober uses: a single `warn` per failed
 * probe. Structural (not `pino`/Fastify-typed) so any compatible logger — or a
 * test spy — satisfies it without an import or an `as` cast.
 */
export interface ProbeLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

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
  /**
   * Optional structured logger. When set, one `warn` is emitted per failed probe
   * with `{ clientId?, host, reason, cause }` (#353) so an unreachable client's
   * root cause is captured in the server logs, not just the health card.
   */
  readonly log?: ProbeLogger;
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
 * The human message behind a thrown error, for a probe-failure detail/log line.
 * For an {@link SshUnreachableError} that carries a `cause` we surface the
 * underlying `ssh2`/socket message (the discriminating text); with no cause
 * there is nothing more informative than the reason itself, so this is empty.
 */
function causeText(error: unknown): string {
  if (error instanceof SshUnreachableError) {
    if (error.cause === undefined || error.cause === null) return "";
    return error.cause instanceof Error ? error.cause.message : String(error.cause);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a probe failure into its reason + a human detail (#353). An
 * {@link SshUnreachableError} carries its own classified {@link SshUnreachableError.reason};
 * an {@link SshExecTimeoutError} (the box answered but a probe command hung) is a
 * `timeout`; any other {@link SshError} that surfaced here degrades to `unknown`.
 */
function describeProbeFailure(error: SshError): {
  reason: SshUnreachableReason;
  detail: string;
  cause: string;
} {
  const reason: SshUnreachableReason =
    error instanceof SshUnreachableError
      ? error.reason
      : error instanceof SshExecTimeoutError
        ? "timeout"
        : "unknown";
  const cause = causeText(error);
  const detail =
    cause === "" ? `host unreachable (${reason})` : `host unreachable (${reason}: ${cause})`;
  return { reason, detail, cause };
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
  readonly #log: ProbeLogger | undefined;

  /**
   * @param transport the SSH transport (or a structural stand-in) to probe over.
   * @param credentials the dashboard's SSH key material (from #39's bootstrap).
   * @param options per-exec overrides, an injectable clock, the AW probe, and an
   *   optional logger.
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
    // Bound the AW probe by the same per-probe timeout as the `exec` probes when
    // one is configured (a positive `timeoutMs`; `0` is exec's "disable"
    // sentinel, which the AW client would misread as "abort immediately"), so a
    // hung `aw-server` can't eat more of the health-service's per-client
    // deadline than a hung `systemctl` would. Falls back to the client's own
    // default when unset.
    const awTimeoutMs = options.execOptions?.timeoutMs;
    this.#probeActivityWatch =
      options.probeActivityWatch ??
      ((baseUrl): Promise<AwServerInfo> =>
        new ActivityWatchClient({
          baseUrl,
          ...(awTimeoutMs !== undefined && awTimeoutMs > 0 ? { timeoutMs: awTimeoutMs } : {}),
        }).getInfo());
    this.#log = options.log;
  }

  async probe(
    client: Pick<ClientRow, "hostname" | "sshUser" | "sshTarget"> & { readonly id?: number },
  ): Promise<ClientProbeResult> {
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
          const { reason, detail, cause } = describeProbeFailure(error);
          this.#log?.warn(
            {
              ...(client.id === undefined ? {} : { clientId: client.id }),
              host: target.host,
              port: target.port ?? 22,
              reason,
              ...(cause === "" ? {} : { cause }),
            },
            "client health probe failed",
          );
          return {
            reachability: "offline",
            at,
            components: allUnknown(detail),
            reachabilityReason: reason,
          };
        }
        throw error;
      }
    }

    return { reachability: "online", at, components, reachabilityReason: null };
  }

  /**
   * Probe the loopback `aw-server` over a port-forward and classify the result.
   * The tunnel is torn down by the facade the moment `getInfo()` settles.
   *
   * An {@link ActivityWatchClient} failure means the host is reachable but
   * `aw-server` didn't answer usefully → `unhealthy`. This covers a *connect-
   * time* SSH failure only indirectly: if the SSH session drops **mid-fetch**
   * the AW client surfaces an `ActivityWatchUnreachableError`, so this component
   * is (correctly, transiently) `unhealthy` — and the very next `systemd-system`
   * probe then re-hits the dead connection and raises an `SshError`, flipping
   * the whole client to `offline`. That relies on a system-service probe
   * following `activitywatch` in {@link CLIENT_COMPONENTS} (it does today).
   *
   * A connect-time `SshError` (the tunnel never opened, so `getInfo()` never
   * ran) or any other non-AW error is rethrown for the caller to map to
   * client-offline / surface as a bug — the SSH layer's reachability is not
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
