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
import { SshError } from "../ssh/errors.js";
import {
  targetFromClient,
  type ExecOptions,
  type ExecResult,
  type SshCredentials,
  type SshTarget,
} from "../ssh/facade.js";
import {
  CLIENT_COMPONENTS,
  classifyServiceState,
  systemdIsActiveArgv,
  type ClientComponent,
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
 * (a non-zero `systemctl is-active` is data, not an error). Declared
 * structurally so the real {@link SshTransport} satisfies it and tests can pass
 * a lightweight fake without an `as` cast — same pattern as `TimekprTransport`.
 */
export interface HealthProbeTransport {
  exec(target: SshTarget, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

/** Construction options for {@link SshClientProber}. */
export interface SshClientProberOptions {
  /** Per-exec overrides (e.g. a tighter `timeoutMs`) forwarded to the transport. */
  readonly execOptions?: ExecOptions;
  /** Clock for `result.at`; overridable in tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
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

  /**
   * @param transport the SSH transport (or a structural stand-in) to probe over.
   * @param credentials the dashboard's SSH key material (from #39's bootstrap).
   * @param options per-exec overrides and an injectable clock.
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
  }

  async probe(client: Pick<ClientRow, "hostname" | "sshUser">): Promise<ClientProbeResult> {
    const target = targetFromClient(client, this.#credentials);
    const at = this.#now();
    const components: ComponentHealthResult[] = [];

    for (const descriptor of CLIENT_COMPONENTS) {
      if (descriptor.probe.method === "deferred") {
        components.push({
          component: descriptor.component,
          status: "unknown",
          detail: descriptor.probe.detail,
        });
        continue;
      }
      try {
        const result = await this.#transport.exec(
          target,
          systemdIsActiveArgv(descriptor.probe.unit),
          this.#execOptions,
        );
        const verdict = classifyServiceState(result.stdout);
        components.push({
          component: descriptor.component,
          status: verdict.status,
          detail: verdict.detail,
        });
      } catch (error) {
        // The facade's unchecked `exec` only rejects with the SSH error taxonomy
        // (unreachable / timed out — `inactive` is a non-zero exit, not a
        // rejection). Any of these means the box stopped answering mid-probe, so
        // the whole client is offline. A non-`SshError` is an unexpected bug and
        // must surface, not masquerade as "offline".
        if (error instanceof SshError) {
          return { reachability: "offline", at, components: allUnknown("host unreachable") };
        }
        throw error;
      }
    }

    return { reachability: "online", at, components };
  }
}
