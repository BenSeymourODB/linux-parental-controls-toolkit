/**
 * Replay loop for the offline transport queue (#84).
 *
 * {@link drainClient} walks one client's `pending` actions oldest-first and
 * hands each to the injected {@link ActionExecutor}. The retriable-vs-not
 * split is the `transport/ssh` {@link SshError} taxonomy ({@link isRetriable}):
 *
 * - **success** → the row is deleted ({@link markDrained}).
 * - **retriable failure** (host unreachable / timed out) → record the attempt,
 *   leave the row `pending`, and **stop** draining this client — everything
 *   behind the head is for the same now-unreachable host, so there's no point
 *   hammering it. The deferred work waits for a later tick (never dropped). By
 *   design there is **no attempt-count cap** on a retriable failure: a client
 *   that stays offline for a long time keeps its queued pushes rather than
 *   having them silently dead-lettered. `attempts` is observability only (how
 *   many times we've tried), surfaced to the admin — not a retry budget.
 * - **non-retriable failure** (the command itself failed, or an unclassifiable
 *   rejection) → dead-letter the row ({@link markFailed}) and continue past it,
 *   so one poison action can't wedge the queue head.
 *
 * **Idempotency contract.** Delivery is at-least-once: a crash after the
 * executor succeeds but before {@link markDrained} runs replays the action on
 * the next tick. Executors must therefore be idempotent — which the Timekpr
 * `timekpra` setters are (they assert a desired state, not a delta). The queue
 * itself keeps at most one row per `(client, coalesceKey)`, so duplicate
 * targets never accumulate.
 *
 * License boundary: none touched — orchestration over Drizzle + the injected
 * executor; the executor is what (later) execs over the SSH facade.
 */
import type { PolicyDb } from "../../policy/db.js";
import { markDrained, markFailed, recordAttempt, listPendingForClient } from "./repository.js";
import {
  errorMessage,
  isRetriable,
  type ActionExecutor,
  type DrainSummary,
  type QueuedAction,
  type QueuedActionRow,
} from "./types.js";

/** Narrow a stored row to the {@link QueuedAction} content the executor receives. */
function toAction(row: QueuedActionRow): QueuedAction {
  return {
    clientId: row.clientId,
    coalesceKey: row.coalesceKey,
    kind: row.kind,
    payload: row.payload,
  };
}

/**
 * Drain one client's queue. Resolves with a {@link DrainSummary} of what
 * happened; never rejects — a retriable executor failure is the queue's normal
 * "still offline" signal, not an error the caller must catch.
 *
 * Actions are replayed strictly in `enqueued` order so a later supersession of
 * an earlier action (already coalesced at enqueue time) can't be reordered
 * behind unrelated work.
 */
export async function drainClient(
  db: PolicyDb,
  clientId: number,
  executor: ActionExecutor,
): Promise<DrainSummary> {
  const pending = listPendingForClient(db, clientId);
  let drained = 0;
  let failed = 0;

  // `.entries()` yields a defined `row` (unlike `pending[index]` under
  // noUncheckedIndexedAccess), so there's no dead undefined-guard branch.
  for (const [index, row] of pending.entries()) {
    try {
      await executor(toAction(row));
      markDrained(db, row.id);
      drained += 1;
    } catch (error) {
      const message = errorMessage(error);
      if (isRetriable(error)) {
        // Host went offline mid-drain: keep this row and everything behind it
        // pending for a later tick. Count the untried remainder as deferred.
        recordAttempt(db, row.id, message);
        return { drained, failed, deferred: pending.length - index };
      }
      // The command itself failed — replaying it unchanged won't help, so
      // dead-letter it and move on rather than blocking the queue head.
      markFailed(db, row.id, message);
      failed += 1;
    }
  }

  return { drained, failed, deferred: 0 };
}
