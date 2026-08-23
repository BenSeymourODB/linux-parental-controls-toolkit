/**
 * zod DTOs for the client health/status surface (#81): the contract the admin
 * "Clients" page consumes to show, per enrolled client, its reachability,
 * per-component health, and offline + queued-change state.
 *
 * As with every `/api/*` DTO these are the single contract shared with the
 * SvelteKit frontend and any integrator — types are inferred, never written
 * twice (`CLAUDE.md` → "api/ — zod DTOs"). The component and reachability enums
 * are derived from the `transport/health` catalogue so the wire contract and
 * the prober can never drift; the queue-action shape is derived from the
 * `transport_queue` status enum for the same reason.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { transportQueueStatusValues } from "../../policy/enums.js";
import type { QueuedActionRow } from "../../transport/queue/index.js";
import {
  clientComponentValues,
  componentHealthStatusValues,
  clientReachabilityValues,
  sshUnreachableReasonValues,
} from "../../transport/health/index.js";
import { clientVersionStatusValues } from "./version-status.js";

/** Health of one supervised component on a client. */
export const componentHealthSchema = z.object({
  component: z.enum(clientComponentValues),
  status: z.enum(componentHealthStatusValues),
  /** Human-readable detail: the systemd state, the deferral reason, etc. */
  detail: z.string(),
});

/**
 * One row of a client's capability matrix (#400): a known capability from the
 * server catalogue, its admin-facing label, and whether *this* client
 * advertised support for it in its event-stream handshake. The frontend renders
 * every catalogue entry and greys out the unsupported ones.
 */
export const clientCapabilitySchema = z.object({
  /** The capability id (`per_app_close`, `session_budget`, …). */
  capability: z.string(),
  /** Admin-facing label from the server catalogue. */
  label: z.string(),
  /** Did this client advertise the capability on its last handshake? */
  supported: z.boolean(),
});

/**
 * A single queued (or dead-lettered) transport action for a client — the
 * "what's pending / what got stuck" the admin sees for an unreachable client.
 * Mirrors the `transport_queue` row, with timestamps serialised as ISO strings.
 */
export const queuedActionSummarySchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  coalesceKey: z.string(),
  status: z.enum(transportQueueStatusValues),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  enqueuedAt: z.string(),
  updatedAt: z.string(),
});

/** A client's offline-queue state: outstanding counts plus the per-row detail. */
export const clientQueueSchema = z.object({
  /** Count of `pending` (awaiting replay) actions. */
  pending: z.number().int(),
  /** Count of dead-lettered `failed` actions (visible, not blocking the head). */
  failed: z.number().int(),
  /** Every queued row (pending + failed), oldest first. */
  actions: z.array(queuedActionSummarySchema),
});

/** Full health/status for one enrolled client. */
export const clientHealthSchema = z.object({
  clientId: z.number().int(),
  hostname: z.string(),
  /** The admin-chosen friendly name (the card's preferred title), or null (#355). */
  friendlyName: z.string().nullable(),
  /** The client's self-reported IP address(es) at enrol, or null (#355). */
  reportedIps: z.array(z.string()).nullable(),
  /** The observed source IP of the enrol request, or null (#355). */
  sourceIp: z.string().nullable(),
  reachability: z.enum(clientReachabilityValues),
  /**
   * When the client is `offline`, the classified SSH failure cause (#353) —
   * `dns` / `connection_refused` / `timeout` / `auth` / `handshake` / `unknown`
   * — so the card can badge *why* and offer a targeted remediation hint instead
   * of one catch-all string. `null` when the client is online or wasn't probed.
   * The free-text `components[].detail` still carries the full human message.
   */
  reachabilityReason: z.enum(sshUnreachableReasonValues).nullable(),
  /** Last time the client was confirmed reachable (ISO), or null if never. */
  lastSeen: z.string().nullable(),
  enrolledAt: z.string(),
  /** When this status was probed (ISO), or null when no probe ran (degraded). */
  probedAt: z.string().nullable(),
  /**
   * Set when the client's event-stream `hello` was refused for running an
   * out-of-window protocol (ADR 0007 §5, #165): the admin signal that this
   * client needs a `pct-client` agent update before it can reconnect.
   */
  updateRequired: z.boolean(),
  /** The agent version the client last reported (enrol or handshake), or null (#164). */
  agentVersion: z.string().nullable(),
  /** When that version was last reported (ISO), or null if never (#164). */
  versionsReportedAt: z.string().nullable(),
  /**
   * The dashboard's own release version, or null when the build didn't stamp
   * one (dev/test). Echoed per row so the card can show "client X vs server Y"
   * and the admin has one place to read the server version (#352).
   */
  serverVersion: z.string().nullable(),
  /**
   * The version-drift verdict the card badges on (#352): `update_required` (the
   * protocol handshake refused it), `outdated` (behind the server), `up_to_date`
   * (equal or newer), or `unknown` (nothing to compare). Computed server-side
   * from {@link updateRequired} + agent/server versions so the frontend never
   * reimplements the comparison.
   */
  versionStatus: z.enum(clientVersionStatusValues),
  components: z.array(componentHealthSchema),
  /**
   * Whether the client has ever completed an event-stream handshake and so
   * reported a capability set (#400). `false` for an admin-CRUD row or an
   * enrolled client the bridge has not yet connected from — the view then shows
   * a "not reported yet" state rather than a wall of greyed controls.
   */
  capabilitiesReported: z.boolean(),
  /**
   * The full known capability catalogue, each entry flagged `supported` for
   * this client (#400). Always the complete catalogue so the view can render
   * every control and grey out the ones this client can't honour; when
   * {@link capabilitiesReported} is `false`, every entry is `supported: false`.
   */
  capabilities: z.array(clientCapabilitySchema),
  queue: clientQueueSchema,
});

/** A list of per-client health/status records. */
export const clientHealthListSchema = z.array(clientHealthSchema);

export type ComponentHealthDto = z.infer<typeof componentHealthSchema>;
export type ClientCapabilityDto = z.infer<typeof clientCapabilitySchema>;
export type QueuedActionSummary = z.infer<typeof queuedActionSummarySchema>;
export type ClientQueueDto = z.infer<typeof clientQueueSchema>;
export type ClientHealthResponse = z.infer<typeof clientHealthSchema>;

/** Map a persisted `transport_queue` row to its wire summary. */
export function toQueuedActionSummary(row: QueuedActionRow): QueuedActionSummary {
  return {
    id: row.id,
    kind: row.kind,
    coalesceKey: row.coalesceKey,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    enqueuedAt: row.enqueuedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
