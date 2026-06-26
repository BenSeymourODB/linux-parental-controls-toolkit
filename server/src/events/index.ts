/**
 * WebSocket server-to-client event stream (#100, Phase 8b).
 *
 * The channel the `pct-client-bridge` connects to (`docs/client-notifications.md`):
 * `GET /api/events/stream`, per-client bearer auth, a typed event taxonomy, and
 * the {@link EventHub} fan-out registry the later event producers publish onto.
 * This barrel is the module's import surface; the taxonomy schemas/types are
 * additionally re-exported from the `api/` barrel as part of the `/api`
 * contract the client bridge and integrators consume.
 */
export const moduleName = "events";

export { EventHub, SOCKET_OPEN, type EventSocket } from "./hub.js";
export { registerEventStream, type EventStreamOptions } from "./stream.js";
export {
  startHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type HeartbeatSocket,
  type HeartbeatHandle,
} from "./heartbeat.js";
export { authenticateEventClient } from "./auth.js";
export {
  serverEventSchema,
  eventFrameSchema,
  grantAppliedSchema,
  policyChangedSchema,
  enforceForceCloseSchema,
  enforceSessionLockSchema,
  lockoutClearedSchema,
  type ServerEvent,
  type ServerEventType,
  type EventFrame,
} from "./taxonomy.js";
