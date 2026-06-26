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
} from "../../transport/health/index.js";

/** Health of one supervised component on a client. */
export const componentHealthSchema = z.object({
  component: z.enum(clientComponentValues),
  status: z.enum(componentHealthStatusValues),
  /** Human-readable detail: the systemd state, the deferral reason, etc. */
  detail: z.string(),
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
  reachability: z.enum(clientReachabilityValues),
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
  components: z.array(componentHealthSchema),
  queue: clientQueueSchema,
});

/** A list of per-client health/status records. */
export const clientHealthListSchema = z.array(clientHealthSchema);

export type ComponentHealthDto = z.infer<typeof componentHealthSchema>;
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
