/**
 * Scheduled retention purge (#137, epic #135).
 *
 * A croner job (`CLAUDE.md` → "Scheduling: croner for in-process periodic
 * jobs") that, each tick, rebuilds the effective {@link RetentionPolicy} from
 * the env default + persisted per-category overrides and runs
 * {@link runRetentionPurge}, so a window change made via `/api/retention` takes
 * effect on the next tick without a restart. Every run is recorded in the
 * `retention_purge_runs` ledger by the service, so purges are observable
 * (the admin retention page reads the latest run).
 *
 * Like the other schedulers (`scheduleTelemetryPull`, the re-apply scheduler,
 * the offline-queue drainer, the enforcement pipeline), constructing this
 * starts **no** timer: `buildApp`/`buildAppServices` construct it, `main.ts`
 * calls {@link RetentionPurgeSchedulerHandle.start} after `listen`, and the
 * app's `onClose` teardown calls `stop()`. Overlapping runs are suppressed
 * (croner `protect`), and a thrown pass is caught, logged, and isolated so it
 * never escapes the tick or wedges the schedule.
 *
 * Unlike the transport schedulers this needs no SSH or external service — a
 * purge is pure DB maintenance — so it is always constructed (no keyless
 * no-op case).
 *
 * License boundary: none touched — croner (MIT) + Drizzle over the policy
 * store. No GPL linkage, no subprocess/REST boundary, no image change.
 */
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";

import type { PolicyDb } from "../policy/db.js";
import { listRetentionOverrides } from "../policy/repository.js";
import { RetentionPolicy } from "../policy/retention.js";
import { runRetentionPurge } from "./service.js";

/**
 * Default cadence: purge daily at 03:00. Retention is not latency-critical, and
 * an off-peak hour keeps the (batched) first run clear of the busy evening.
 * Mirrors the `config.ts` `retention.purgeCron` default.
 */
export const DEFAULT_RETENTION_PURGE_PATTERN = "0 3 * * *";

/** The pino `component` tag every scheduler log line carries (#11). */
export const RETENTION_PURGE_LOG_COMPONENT = "retention/purge";

/** Wiring for {@link createRetentionPurgeScheduler}. */
export interface RetentionPurgeSchedulerOptions {
  /** The shared policy-store connection the purge deletes from. */
  readonly db: PolicyDb;
  /** Global default retention window (days) for categories without an override. */
  readonly defaultDays: number;
  /** croner pattern; defaults to {@link DEFAULT_RETENTION_PURGE_PATTERN}. */
  readonly pattern?: string;
  /** Rows deleted per pass; defaults to the purge module's default. */
  readonly batchSize?: number;
  /** Base logger; a `retention/purge` child is derived for the job's lines. */
  readonly log: FastifyBaseLogger;
  /** Clock seam for the run's cutoff instant; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** A constructed scheduler the caller starts, kicks manually, or stops. */
export interface RetentionPurgeSchedulerHandle {
  /** Begin the cron schedule (idempotent; a second call is a no-op). */
  start(): void;
  /** Run one purge pass now (also what each cron tick invokes). */
  tick(): void;
  /** Stop the schedule permanently (e.g. on `app.close()`). */
  stop(): void;
}

/**
 * Construct the scheduled retention purge. The `Cron` is created lazily in
 * {@link RetentionPurgeSchedulerHandle.start} so merely building the app starts
 * no timer (test-safe, matching the enforcement pipeline).
 */
export function createRetentionPurgeScheduler(
  options: RetentionPurgeSchedulerOptions,
): RetentionPurgeSchedulerHandle {
  const { db, defaultDays, log } = options;
  const pattern = options.pattern ?? DEFAULT_RETENTION_PURGE_PATTERN;
  const now = options.now ?? ((): Date => new Date());
  const child = log.child({ component: RETENTION_PURGE_LOG_COMPONENT });

  let job: Cron | null = null;

  const tick = (): void => {
    try {
      // Rebuild the effective policy each pass so a window change via
      // /api/retention applies on the next tick without a restart.
      const policy = RetentionPolicy.fromOverrides(defaultDays, listRetentionOverrides(db));
      const run = runRetentionPurge(db, policy, now(), {
        trigger: "scheduled",
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      });
      child.info(
        { runId: run.id, totalDeleted: run.totalDeleted, durationMs: run.durationMs },
        "retention purge pass complete",
      );
    } catch (err) {
      // A failed pass must never escape the tick or wedge the schedule; the next
      // tick retries (the cutoff predicate is stable, so a partial purge simply
      // resumes). Logged so the admin can see it.
      child.error({ err }, "retention purge pass failed");
    }
  };

  return {
    start: (): void => {
      if (job === null) {
        job = new Cron(pattern, { name: "retention-purge", protect: true }, tick);
      }
    },
    tick,
    stop: (): void => {
      job?.stop();
      job = null;
    },
  };
}
