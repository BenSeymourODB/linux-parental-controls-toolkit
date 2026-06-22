/**
 * The live policy-push dispatcher (#201, Phase 4) — the drop-in replacement for
 * the Phase-2 logging stub (`../stub.ts`).
 *
 * It implements the same {@link PolicyPushStub} surface the CRUD routes already
 * call (`push(commands)`), so the call sites and the computed
 * {@link PolicyPushCommand} shape do not change. For each command it routes
 * through the offline queue's {@link pushOrEnqueue}: push to the client now and,
 * if the client is unreachable, persist the action for replay (#84) rather than
 * losing the change. The concrete remote work is the injected
 * {@link ActionExecutor} (the live `timekpra`-over-SSH executor in production).
 *
 * **Fire-and-forget, by design.** `push` is synchronous and returns `void` — the
 * same contract the stub has, so the route handlers stay unchanged and an HTTP
 * mutation does not block on SSH round-trips to (possibly offline) clients. Each
 * push's outcome (`pushed`/`queued`) is logged, and any non-retriable failure is
 * caught and logged — it never escapes into the request. Durability for an
 * *unreachable* client comes from the queue + the periodic drainer; the audit
 * log (#85) records every issued command for the admin Clients/audit views.
 *
 * License boundary: none touched — orchestration over the queue facade + the
 * injected executor, which execs over the SSH subprocess boundary.
 */
import type { FastifyBaseLogger } from "fastify";

import type { PolicyDb } from "../../policy/db.js";
import { pushOrEnqueue } from "../queue/facade.js";
import { queuedActionFromPolicyPush } from "../queue/policy-push.js";
import type { ActionExecutor } from "../queue/types.js";
import type { PolicyPushCommand, PolicyPushStub } from "../stub.js";

/** Pino `component` tag identifying live policy-push log lines (per #11). */
export const POLICY_PUSH_COMPONENT = "transport/policy-push";

/** Construction options for {@link createPolicyPushDispatcher}. */
export interface PolicyPushDispatcherOptions {
  /** The shared policy-store handle (the queue + executor read/write it). */
  readonly db: PolicyDb;
  /** Performs one push against its client (the live `timekpra`-over-SSH executor). */
  readonly executor: ActionExecutor;
  /** Base logger; a {@link POLICY_PUSH_COMPONENT} child is derived for outcomes. */
  readonly log: FastifyBaseLogger;
}

/**
 * Build the live dispatcher. The returned object is a {@link PolicyPushStub}, so
 * it drops straight into `registerPolicyRoutes` where the logging stub is today.
 */
export function createPolicyPushDispatcher(options: PolicyPushDispatcherOptions): PolicyPushStub {
  const { db, executor } = options;
  const child = options.log.child({ component: POLICY_PUSH_COMPONENT });

  function dispatch(command: PolicyPushCommand): void {
    const action = queuedActionFromPolicyPush(command);
    // Fire-and-forget: the push runs without blocking the HTTP response. The
    // promise is fully settled here (then + catch), so it can never surface as
    // an unhandled rejection.
    void pushOrEnqueue(db, action, executor).then(
      (outcome) => {
        child.info(
          {
            clientId: command.clientId,
            userId: command.userId,
            reason: command.reason,
            ...outcome,
          },
          outcome.status === "queued"
            ? "policy push deferred: client offline, queued for replay"
            : "policy push delivered",
        );
      },
      (error: unknown) => {
        // A non-retriable failure (the command itself failed) — pushOrEnqueue
        // rethrows it rather than queuing a command that can't succeed. Log it;
        // the audit log (#85) already captured the per-command outcome.
        child.error(
          {
            err: error,
            clientId: command.clientId,
            userId: command.userId,
            reason: command.reason,
          },
          "policy push failed",
        );
      },
    );
  }

  return {
    push(commands) {
      for (const command of commands) dispatch(command);
    },
  };
}
