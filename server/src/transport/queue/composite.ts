/**
 * Compose several per-`kind` {@link ActionExecutor}s into the single executor
 * the {@link ./drainer.ts} drain loop (and {@link ./facade.ts} push site) drive.
 *
 * The queue stores a `kind` discriminator per action; once more than one kind
 * is queued (e.g. `policy.push` from CRUD mutations and `timekpr.time-today`
 * from the same-day lever), the drainer's single executor slot has to fan out
 * by `kind`. This keeps that dispatch in one tested place rather than branching
 * inside the bootstrap wiring.
 *
 * An action whose `kind` has no registered executor is a programming error
 * (something enqueued a kind nothing can replay): it rejects **non-retriably**
 * so the drainer dead-letters the row (visible to the admin) rather than
 * retrying it forever or wedging the queue head.
 *
 * License boundary: none touched — plain dispatch over the injected executors.
 */
import type { ActionExecutor, QueuedAction } from "./types.js";

/**
 * Build an {@link ActionExecutor} that dispatches each action to the executor
 * registered for its `kind`. Unknown kinds reject (non-retriable).
 */
export function compositeExecutor(
  byKind: Readonly<Record<string, ActionExecutor>>,
): ActionExecutor {
  return function execute(action: QueuedAction): Promise<void> {
    const executor = byKind[action.kind];
    if (executor === undefined) {
      return Promise.reject(
        new Error(
          `offline queue: no executor registered for action kind ${JSON.stringify(action.kind)}`,
        ),
      );
    }
    return executor(action);
  };
}
