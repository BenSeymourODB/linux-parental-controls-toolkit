/**
 * The supervised-client component catalogue and the `systemctl is-active`
 * classification the health probe (#81) uses.
 *
 * Each enrolled client runs a fixed set of components the dashboard wants to
 * report health for. The catalogue here is the single source of *what* to
 * probe and *how*; the {@link ./prober.ts} `SshClientProber` walks it, and the
 * `api/clients` health DTO derives its component enum from
 * {@link clientComponentValues} so the contract and the prober can never drift.
 *
 * The probe shapes are grounded in `client/`'s install scripts and
 * `client/self-test.sh`, which already determine liveness with
 * `systemctl is-active <unit>` (a read-only query — no privilege required, so
 * the dashboard runs it as the unprivileged `pct-agent`). System services
 * (`timekpr.service`, `e2guardian.service`, and the Phase-8b
 * `pct-client-bridge.service`) are probed that way.
 *
 * ActivityWatch's loopback `aw-server` is reached differently: it binds
 * `127.0.0.1:5600` and is never network-exposed, so it is probed over an SSH
 * port-forward with a REST-only `GET /api/0/info` (#323, the {@link
 * ActivityWatchRestProbe} method — the same tunnel the Phase-5 telemetry pull
 * uses). Reported per-client against the conventional 5600 bind; multi-user-
 * per-client breakdown is deferred with the per-user `pct-client-agent` probe
 * (Phase 8b #103), which shares that dimensionality — until it lands
 * `pct-client-agent` is reported `unknown`, never guessed.
 *
 * License boundary: none collapsed — the system probes only *name* the
 * commands the SSH facade execs as subprocesses, and `aw-server` is reached
 * solely over its documented HTTP REST API through the loopback SSH tunnel
 * (`CLAUDE.md` → rule 4). No GPL code is linked in-process.
 */
import {
  ActivityWatchParseError,
  ActivityWatchRequestError,
  ActivityWatchUnreachableError,
} from "../activitywatch/errors.js";
import type { AwServerInfo } from "../activitywatch/schemas.js";

/** The components the dashboard reports per-client health for (the DTO enum). */
export const clientComponentValues = [
  "timekpr-next",
  "activitywatch",
  "e2guardian",
  "pct-client-bridge",
  "pct-client-agent",
] as const;

/** One supervised client-side component. */
export type ClientComponent = (typeof clientComponentValues)[number];

/** Health verdict for a single component. */
export const componentHealthStatusValues = ["ok", "unhealthy", "unknown"] as const;

/** `ok` (running), `unhealthy` (reached, not running), `unknown` (not probed). */
export type ComponentHealthStatus = (typeof componentHealthStatusValues)[number];

/** Probe a system-level systemd unit with `systemctl is-active <unit>`. */
export interface SystemServiceProbe {
  readonly method: "systemd-system";
  /** The system unit to query, e.g. `timekpr.service`. */
  readonly unit: string;
}

/**
 * Probe ActivityWatch's loopback `aw-server` over an SSH port-forward with a
 * REST-only `GET /api/0/info` (#323). `aw-server` binds `127.0.0.1` and is
 * never network-exposed, so the tunnel is the only path to it — the same
 * loopback forward the Phase-5 telemetry pull opens.
 */
export interface ActivityWatchRestProbe {
  readonly method: "activitywatch-rest";
  /** Loopback `aw-server` port on the client (its documented bind, `5600`). */
  readonly port: number;
}

/**
 * A component whose probe is not yet defined (per-user / loopback components
 * that land with a later phase). Always reported `unknown` with {@link detail}.
 */
export interface DeferredProbe {
  readonly method: "deferred";
  /** Why it's `unknown` (surfaced to the admin), e.g. the owning phase/issue. */
  readonly detail: string;
}

/** How a single component's health is determined. */
export type ComponentProbe = SystemServiceProbe | ActivityWatchRestProbe | DeferredProbe;

/** The conventional loopback port `aw-server` binds on the client (#86). */
export const AW_SERVER_PORT = 5600;

/** A component paired with how to probe it. */
export interface ComponentDescriptor {
  readonly component: ClientComponent;
  readonly probe: ComponentProbe;
}

/**
 * The fixed probe catalogue. Order is the order the prober reports components
 * in (and matches {@link clientComponentValues}).
 */
export const CLIENT_COMPONENTS: readonly ComponentDescriptor[] = [
  { component: "timekpr-next", probe: { method: "systemd-system", unit: "timekpr.service" } },
  {
    component: "activitywatch",
    probe: { method: "activitywatch-rest", port: AW_SERVER_PORT },
  },
  { component: "e2guardian", probe: { method: "systemd-system", unit: "e2guardian.service" } },
  {
    component: "pct-client-bridge",
    probe: { method: "systemd-system", unit: "pct-client-bridge.service" },
  },
  {
    component: "pct-client-agent",
    probe: {
      method: "deferred",
      detail: "per-user systemd --user probe lands with Phase 8b (#103)",
    },
  },
];

/** The argv that queries a system unit's liveness (no privilege required). */
export function systemdIsActiveArgv(unit: string): readonly string[] {
  return ["systemctl", "is-active", unit];
}

/** A classified service state: the verdict plus a human-readable detail. */
export interface ComponentClassification {
  readonly status: ComponentHealthStatus;
  readonly detail: string;
}

/**
 * Map `systemctl is-active <unit>` stdout to a component verdict.
 *
 * `is-active` prints one word — `active`, `inactive`, `failed`, `activating`,
 * `deactivating`, `reloading`, `maintenance`, or `unknown` — and exits non-zero
 * for anything but `active`, so the caller must use the facade's *unchecked*
 * `exec` (not `execChecked`). Only `active` is healthy (mirroring
 * `self-test.sh`); any other reported state is `unhealthy` with that state as
 * the detail; empty output (nothing reported) is `unknown`.
 */
export function classifyServiceState(stdout: string): ComponentClassification {
  const state = stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (state === "active") return { status: "ok", detail: "active" };
  if (state === "") return { status: "unknown", detail: "no state reported" };
  return { status: "unhealthy", detail: state };
}

/**
 * `aw-server` answered `GET /api/0/info` → the component is `ok`. The reported
 * server version rides in the detail so the admin can spot a client running a
 * stale ActivityWatch.
 */
export function classifyActivityWatchInfo(info: AwServerInfo): ComponentClassification {
  return { status: "ok", detail: `aw-server ${info.version}` };
}

/**
 * Map an {@link ActivityWatchClient} failure to an `unhealthy` detail. Only
 * called when the SSH tunnel itself opened (the SSH-layer taxonomy is handled
 * one level up as client-offline → `unknown`, never as an AW verdict): here the
 * host is reachable but `aw-server` didn't answer usefully. A non-AW error is a
 * bug and must surface, not masquerade as `unhealthy` — the caller rethrows it.
 */
export function activityWatchFailureDetail(error: unknown): string | undefined {
  if (error instanceof ActivityWatchUnreachableError) {
    return error.timedOut ? "aw-server did not respond in time" : "aw-server not responding";
  }
  if (error instanceof ActivityWatchRequestError) {
    return `aw-server returned HTTP ${error.statusCode}`;
  }
  if (error instanceof ActivityWatchParseError) {
    return "aw-server sent an unrecognised response";
  }
  return undefined;
}
