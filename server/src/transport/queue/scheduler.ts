/**
 * Periodic drainer for the offline transport queue (#84).
 *
 * A croner job (`CLAUDE.md` → "Scheduling: croner for in-process periodic
 * jobs") that, each tick, finds the clients with pending actions, probes each,
 * and drains the reachable ones. This is the "replay on next successful SSH
 * probe" half of the offline failure mode (`docs/architecture.md` → "Client
 * offline at policy-change time"). A retriable failure mid-drain just leaves
 * the work queued for the next tick.
 *
 * The {@link ReachabilityProbe} and {@link ActionExecutor} are injected: the
 * real ones exec over the `transport/ssh` facade and need the SSH key material
 * the entrypoint provisions (#39), and the concrete push is the timekpra
 * wrapper (#83). Until those land, this scheduler is wired by its caller rather
 * than started inside `buildApp` — keeping it free of any GPL/transport
 * coupling here.
 *
 * License boundary: none touched — croner (MIT) + the injected seams.
 */
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";

import type { PolicyDb } from "../../policy/db.js";
import { drainClient } from "./drainer.js";
import { clientsWithPending } from "./repository.js";
import type { ActionExecutor, ReachabilityProbe } from "./types.js";

/** Default cadence: probe + drain once a minute (the offline-queue isn't latency-critical). */
export const DEFAULT_DRAIN_PATTERN = "*/1 * * * *";

/** The pino `component` tag every scheduler/drain log line carries. */
export const QUEUE_LOG_COMPONENT = "transport/queue";

/** Wiring for {@link startOfflineQueueDrainer}. */
export interface OfflineQueueDrainerOptions {
  /** The shared policy-store handle the queue lives in. */
  readonly db: PolicyDb;
  /** Whether a client is reachable right now (injected; SSH probe in prod). */
  readonly probe: ReachabilityProbe;
  /** Performs one queued action against its client (injected; SSH push in prod). */
  readonly executor: ActionExecutor;
  /** Base logger; a `transport/queue` child is derived for the job's lines. */
  readonly log: FastifyBaseLogger;
  /** croner pattern; defaults to {@link DEFAULT_DRAIN_PATTERN}. */
  readonly pattern?: string;
}

/** A running drainer the caller can kick manually or stop on shutdown. */
export interface OfflineQueueDrainerHandle {
  /** Run one probe-and-drain pass now (also what each cron tick invokes). */
  tick(): Promise<void>;
  /** Stop the schedule permanently (e.g. on `app.close()`). */
  stop(): void;
}

/**
 * Start the periodic offline-queue drainer and return a handle. Overlapping
 * runs are suppressed (croner `protect`), so a slow drain can't stack up behind
 * the schedule. One client's probe/drain failure is logged and isolated so it
 * never aborts the others' passes.
 */
export function startOfflineQueueDrainer(
  options: OfflineQueueDrainerOptions,
): OfflineQueueDrainerHandle {
  const { db, probe, executor, log } = options;
  const pattern = options.pattern ?? DEFAULT_DRAIN_PATTERN;
  const child = log.child({ component: QUEUE_LOG_COMPONENT });

  const tick = async (): Promise<void> => {
    for (const clientId of clientsWithPending(db)) {
      try {
        if (!(await probe(clientId))) continue;
        const summary = await drainClient(db, clientId, executor);
        if (summary.drained > 0 || summary.failed > 0) {
          child.info({ clientId, ...summary }, "offline-queue drain pass");
        }
      } catch (error) {
        // A probe (or unexpected) failure for one client must not abort the
        // rest of the pass — log it and move on to the next client.
        child.error({ clientId, err: error }, "offline-queue drain error");
      }
    }
  };

  const job = new Cron(pattern, { name: "offline-queue-drainer", protect: true }, tick);

  return {
    tick,
    stop: () => job.stop(),
  };
}
