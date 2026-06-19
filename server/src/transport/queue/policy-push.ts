/**
 * Adapter from the stub transport's {@link PolicyPushCommand} (`transport/stub.ts`)
 * to a queued action (#84).
 *
 * The stub transport already computes the *intended* per-client effect of a
 * policy mutation as a `PolicyPushCommand`. When the Phase-4 push (over the SSH
 * facade, #83) can't reach a client, that same command is what gets queued —
 * so the queue speaks the established command shape rather than inventing a new
 * one. The coalesce key collapses repeated edits to the same target while a
 * client is offline:
 *
 * - a **user-scoped** change → `user:<id>` (the user's whole effective policy
 *   for that client is recomputed and re-pushed, so the latest wins);
 * - a **client-scoped** change → `client` (the one client-level record).
 */
import type { PolicyPushCommand } from "../stub.js";
import type { NewQueuedAction } from "./types.js";

/** The `kind` discriminator for policy-push payloads in the queue. */
export const POLICY_PUSH_KIND = "policy.push";

/** The serialized form of a {@link PolicyPushCommand} stored as the queue payload. */
export interface PolicyPushPayload extends Record<string, unknown> {
  readonly userId: number | null;
  readonly reason: PolicyPushCommand["reason"];
  readonly detail: PolicyPushCommand["detail"];
}

/**
 * Map a {@link PolicyPushCommand} to the {@link NewQueuedAction} the queue
 * persists. Coalescing on `(clientId, coalesceKey)` means a newer change to the
 * same target supersedes the older queued one.
 */
export function queuedActionFromPolicyPush(command: PolicyPushCommand): NewQueuedAction {
  const payload: PolicyPushPayload = {
    userId: command.userId,
    reason: command.reason,
    detail: command.detail,
  };
  return {
    clientId: command.clientId,
    coalesceKey: command.userId === null ? "client" : `user:${command.userId}`,
    kind: POLICY_PUSH_KIND,
    payload,
  };
}
