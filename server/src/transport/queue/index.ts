/**
 * Offline transport queue (#84): persist per-client policy pushes that can't be
 * delivered because the client is offline, and replay them on the next
 * reachable probe (`docs/architecture.md` → "Client offline at policy-change
 * time").
 *
 * Layering: {@link ./repository.ts} (durable store + coalescing) ←
 * {@link ./drainer.ts} (replay loop) ← {@link ./facade.ts} (push-or-enqueue
 * call site) / {@link ./scheduler.ts} (croner drain job). {@link ./types.ts}
 * holds the shared contract and the injected executor/probe seams;
 * {@link ./policy-push.ts} adapts the stub transport's command shape.
 */
export const moduleName = "transport/queue";

export type {
  ActionExecutor,
  DrainSummary,
  NewQueuedAction,
  QueuedAction,
  QueuedActionRow,
  ReachabilityProbe,
} from "./types.js";
export { errorMessage, isRetriable } from "./types.js";

export {
  clientsWithPending,
  countPendingByClient,
  enqueue,
  listForClient,
  listPendingForClient,
  markDrained,
  markFailed,
  recordAttempt,
  type PendingCount,
} from "./repository.js";

export { drainClient } from "./drainer.js";

export { pushOrEnqueue, type PushOutcome } from "./facade.js";

export {
  POLICY_PUSH_KIND,
  queuedActionFromPolicyPush,
  type PolicyPushPayload,
} from "./policy-push.js";

export {
  DEFAULT_DRAIN_PATTERN,
  QUEUE_LOG_COMPONENT,
  startOfflineQueueDrainer,
  type OfflineQueueDrainerHandle,
  type OfflineQueueDrainerOptions,
} from "./scheduler.js";
