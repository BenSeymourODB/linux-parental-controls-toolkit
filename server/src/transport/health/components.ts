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
 * `pct-client-bridge.service`) are probed that way. The **per-user** components
 * — ActivityWatch's loopback `aw-server` and the per-user
 * `pct-client-agent` (`systemd --user`) — need a per-supervised-user probe
 * (XDG runtime context / loopback REST) whose shape lands with Phase 5 (#86)
 * and Phase 8b (#103); until then they are reported `unknown`, never guessed.
 *
 * License boundary: none touched — this module only *names* the commands the
 * SSH facade execs as subprocesses; no GPL code is linked in-process.
 */

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
 * A component whose probe is not yet defined (per-user / loopback components
 * that land with a later phase). Always reported `unknown` with {@link detail}.
 */
export interface DeferredProbe {
  readonly method: "deferred";
  /** Why it's `unknown` (surfaced to the admin), e.g. the owning phase/issue. */
  readonly detail: string;
}

/** How a single component's health is determined. */
export type ComponentProbe = SystemServiceProbe | DeferredProbe;

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
    probe: { method: "deferred", detail: "per-user aw-server probe lands with Phase 5 (#86)" },
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
