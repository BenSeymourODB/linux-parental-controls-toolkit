/**
 * Client health/status assembly (#81): the logic the health routes delegate to.
 *
 * It joins three sources into the {@link ClientHealthResponse} DTO:
 *  - the persisted {@link clients} row (`enrolledAt`, `lastSeen`),
 *  - the offline transport queue (`transport/queue` `listForClient`) — what is
 *    pending / dead-lettered for the client, and
 *  - an optional live {@link ClientProber} pass (reachability + per-component
 *    health).
 *
 * The prober is **optional** so the endpoint is useful before the SSH-key
 * bootstrap (#39) plumbs live credentials: with no prober, reachability and
 * every component are reported `unknown`, but the real enrolment and queue
 * state still surface. A probe that reaches the client bumps `last_seen` to the
 * probe instant.
 *
 * License boundary: none touched — plain TypeScript + Drizzle; any remote work
 * happens inside the injected prober, over the SSH subprocess facade.
 */
import type { PolicyDb } from "../../policy/db.js";
import * as repo from "../../policy/repository.js";
import type { ClientRow } from "../../policy/repository.js";
import {
  CLIENT_COMPONENTS,
  type ClientProber,
  type ClientProbeResult,
} from "../../transport/health/index.js";
import { listForClient } from "../../transport/queue/index.js";
import { mapWithConcurrency, timerDeadline, type DeadlineFactory } from "../../util/concurrency.js";
import {
  toQueuedActionSummary,
  type ClientHealthResponse,
  type ComponentHealthDto,
} from "./health-dtos.js";

/** Detail shown for every component when no live prober is configured (pre-#39). */
const PROBE_UNCONFIGURED_DETAIL = "SSH probing not yet configured (#39)";

/** Detail when a live probe didn't answer before the per-list deadline (#198). */
const PROBE_DEADLINE_DETAIL = "probe deadline exceeded (#198)";

/** Default clients probed concurrently in one list pass (mirrors telemetry). */
const DEFAULT_PROBE_CONCURRENCY = 4;

/** Default per-list probe deadline in ms (≈1.5× the SSH readyTimeout). */
const DEFAULT_PROBE_DEADLINE_MS = 15_000;

/** Every catalogue component reported `unknown` with one shared detail. */
function unknownComponents(detail: string): ComponentHealthDto[] {
  return CLIENT_COMPONENTS.map((descriptor) => ({
    component: descriptor.component,
    status: "unknown",
    detail,
  }));
}

/**
 * Bump `last_seen` to the probe instant when the client answered, returning the
 * row to report. A non-reachable (or absent) probe leaves the row untouched.
 */
function refreshLastSeen(
  db: PolicyDb,
  client: ClientRow,
  probe: ClientProbeResult | undefined,
): ClientRow {
  if (probe === undefined || probe.reachability !== "online") return client;
  return repo.recordClientLastSeen(db, client.id, probe.at) ?? client;
}

/**
 * Join a client row + its queue rows + an optional probe into the wire DTO.
 * `unknownDetail` is the per-component detail used when there is no probe — the
 * reason differs (no prober wired, deadline exceeded, probe threw), so callers
 * pass the right one.
 */
function assemble(
  db: PolicyDb,
  client: ClientRow,
  probe: ClientProbeResult | undefined,
  unknownDetail = PROBE_UNCONFIGURED_DETAIL,
): ClientHealthResponse {
  const queueRows = listForClient(db, client.id);
  const components: ComponentHealthDto[] =
    probe === undefined
      ? unknownComponents(unknownDetail)
      : probe.components.map((result) => ({
          component: result.component,
          status: result.status,
          detail: result.detail,
        }));

  return {
    clientId: client.id,
    hostname: client.hostname,
    reachability: probe?.reachability ?? "unknown",
    lastSeen: client.lastSeen === null ? null : client.lastSeen.toISOString(),
    enrolledAt: client.enrolledAt.toISOString(),
    probedAt: probe === undefined ? null : probe.at.toISOString(),
    components,
    queue: {
      pending: queueRows.filter((row) => row.status === "pending").length,
      failed: queueRows.filter((row) => row.status === "failed").length,
      actions: queueRows.map(toQueuedActionSummary),
    },
  };
}

/**
 * Health/status for one client by id, or `undefined` if no such client exists.
 * Runs a live probe when `prober` is supplied.
 */
export async function getClientHealth(
  db: PolicyDb,
  clientId: number,
  prober?: ClientProber,
): Promise<ClientHealthResponse | undefined> {
  const client = repo.getClient(db, clientId);
  if (client === undefined) return undefined;
  const probe = prober === undefined ? undefined : await prober.probe(client);
  return assemble(db, refreshLastSeen(db, client, probe), probe);
}

/** Options bounding the live-probe fan-out of {@link listClientHealth} (#198). */
export interface ListClientHealthOptions {
  /**
   * Max clients probed concurrently. Defaults to {@link DEFAULT_PROBE_CONCURRENCY}.
   * `| undefined` so a caller can forward an optional config value verbatim.
   */
  concurrency?: number | undefined;
  /**
   * Per-list probe deadline in ms; a client that hasn't answered by then is
   * reported un-probed so one wedged host can't stall the page. `0` (or less)
   * disables it. Defaults to {@link DEFAULT_PROBE_DEADLINE_MS}.
   */
  deadlineMs?: number | undefined;
  /** Test seam for the deadline timer; defaults to a real `setTimeout` timer. */
  deadlineFactory?: DeadlineFactory;
}

/** The settled outcome of racing one client's probe against the list deadline. */
type ProbeOutcome =
  | { kind: "ok"; probe: ClientProbeResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

/** A safe, component-detail message for a probe that threw. */
function probeErrorDetail(error: unknown): string {
  return `probe failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Probe one client and assemble its DTO, racing the probe against the shared
 * per-list `deadlineReached` (if any). A probe that times out or throws is
 * isolated to this client — it degrades to `unknown` with a reason detail, and
 * the abandoned probe's eventual settlement raises no unhandled rejection (it is
 * folded into a resolved value before the race).
 */
async function probeClient(
  db: PolicyDb,
  prober: ClientProber,
  client: ClientRow,
  deadlineReached: Promise<void> | undefined,
): Promise<ClientHealthResponse> {
  const probed: Promise<ProbeOutcome> = prober.probe(client).then(
    (probe) => ({ kind: "ok", probe }),
    (error: unknown) => ({ kind: "error", error }),
  );
  const outcome: ProbeOutcome =
    deadlineReached === undefined
      ? await probed
      : await Promise.race([probed, deadlineReached.then(() => ({ kind: "timeout" }) as const)]);

  if (outcome.kind === "timeout") return assemble(db, client, undefined, PROBE_DEADLINE_DETAIL);
  if (outcome.kind === "ok") {
    return assemble(db, refreshLastSeen(db, client, outcome.probe), outcome.probe);
  }
  return assemble(db, client, undefined, probeErrorDetail(outcome.error));
}

/**
 * Health/status for every enrolled client, ascending by id.
 *
 * Without a `prober` every client degrades to `unknown` reachability/components
 * while its real enrolment + queue state still surfaces (the pre-#39 state).
 *
 * With a `prober`, clients are probed with **bounded concurrency** and a shared
 * **per-list deadline** so a fleet of offline hosts can't make the page take
 * ~N×`readyTimeout` once the live prober is wired (#39): each probe races the
 * deadline, and a host that misses it — or whose probe throws — is isolated to
 * `unknown` rather than stalling or failing the whole walk. Results stay ordered
 * by id.
 */
export async function listClientHealth(
  db: PolicyDb,
  prober?: ClientProber,
  options: ListClientHealthOptions = {},
): Promise<ClientHealthResponse[]> {
  const clients = repo.listClients(db);
  if (prober === undefined) {
    return clients.map((client) => assemble(db, client, undefined, PROBE_UNCONFIGURED_DETAIL));
  }

  const concurrency = options.concurrency ?? DEFAULT_PROBE_CONCURRENCY;
  const deadlineMs = options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const deadline =
    deadlineMs > 0 ? (options.deadlineFactory ?? timerDeadline)(deadlineMs) : undefined;
  try {
    return await mapWithConcurrency(clients, concurrency, (client) =>
      probeClient(db, prober, client, deadline?.reached),
    );
  } finally {
    deadline?.cancel();
  }
}
