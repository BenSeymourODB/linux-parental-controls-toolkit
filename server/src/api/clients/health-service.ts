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
import {
  toQueuedActionSummary,
  type ClientHealthResponse,
  type ComponentHealthDto,
} from "./health-dtos.js";

/** Detail shown for every component when no live prober is configured (pre-#39). */
const PROBE_UNCONFIGURED_DETAIL = "SSH probing not yet configured (#39)";

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

/** Join a client row + its queue rows + an optional probe into the wire DTO. */
function assemble(
  db: PolicyDb,
  client: ClientRow,
  probe: ClientProbeResult | undefined,
): ClientHealthResponse {
  const queueRows = listForClient(db, client.id);
  const components: ComponentHealthDto[] =
    probe === undefined
      ? unknownComponents(PROBE_UNCONFIGURED_DETAIL)
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

/**
 * Health/status for every enrolled client, ascending by id. Probes each client
 * in turn when `prober` is supplied (the SSH transport pools per host, so a
 * sequential walk reuses connections rather than fanning out). Bounded
 * concurrency / a per-list deadline — so a fleet of offline hosts can't stall
 * the page once the live prober is wired (#39) — is tracked in #198.
 */
export async function listClientHealth(
  db: PolicyDb,
  prober?: ClientProber,
): Promise<ClientHealthResponse[]> {
  const out: ClientHealthResponse[] = [];
  for (const client of repo.listClients(db)) {
    const probe = prober === undefined ? undefined : await prober.probe(client);
    out.push(assemble(db, refreshLastSeen(db, client, probe), probe));
  }
  return out;
}
