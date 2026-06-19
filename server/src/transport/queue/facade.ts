/**
 * The call-site API for pushing through the offline queue (#84).
 *
 * {@link pushOrEnqueue} is what a Phase-4 push site uses instead of calling the
 * executor directly: try the push now, and if the client is unreachable, queue
 * the action for replay rather than losing the change. The split between
 * "queued" and "propagated as an error" is the same {@link isRetriable}
 * classification the drainer uses — a retriable (host-unreachable) failure is
 * the queue's normal path; any other failure means the command itself is wrong
 * and is surfaced to the caller, not silently queued.
 *
 * License boundary: none touched — orchestration over the repository + the
 * injected executor (which is what later execs over the SSH facade).
 */
import type { PolicyDb } from "../../policy/db.js";
import { enqueue } from "./repository.js";
import { errorMessage, isRetriable, type ActionExecutor, type NewQueuedAction } from "./types.js";

/** What {@link pushOrEnqueue} did with an action. */
export type PushOutcome =
  | { readonly status: "pushed" }
  | { readonly status: "queued"; readonly reason: string };

/**
 * Push `action` to its client now; if the client is unreachable, persist it
 * (coalescing onto any existing queued action for the same target) so the
 * drainer replays it on reconnect.
 *
 * - Executor resolves → `{ status: "pushed" }`; nothing is queued.
 * - Executor rejects **retriably** (host unreachable / timed out) → the action
 *   is enqueued and `{ status: "queued", reason }` is returned.
 * - Executor rejects **non-retriably** (the command failed, or an
 *   unclassifiable error) → the rejection propagates; queuing it would just
 *   replay a command that can't succeed.
 */
export async function pushOrEnqueue(
  db: PolicyDb,
  action: NewQueuedAction,
  executor: ActionExecutor,
): Promise<PushOutcome> {
  try {
    await executor({
      clientId: action.clientId,
      coalesceKey: action.coalesceKey,
      kind: action.kind,
      payload: action.payload,
    });
    return { status: "pushed" };
  } catch (error) {
    if (!isRetriable(error)) throw error;
    const reason = errorMessage(error);
    enqueue(db, action);
    return { status: "queued", reason };
  }
}
