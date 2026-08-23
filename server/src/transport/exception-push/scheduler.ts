/**
 * Date-specific override enforcement push (#399, Phase 13).
 *
 * ADR 0012 composed date-specific `exceptions` (`allow` / `deny` / `extend`, own
 * + inherited group) into the effective-policy resolver, but §3 deliberately
 * kept them out of the recurring `timekpra` allowed-hours grid and named this as
 * the follow-up: pushing a date-specific override to the client **when its
 * window arrives** (and reverting after) is an offline-queue scheduler concern
 * (#84). This module is that scheduler.
 *
 * A one-off calendar date is not a weekly-recurring pattern, so the standing
 * push stays exception-free (the clean recurring baseline / revert target). Each
 * tick this job resolves the **exception-inclusive** weekly grid for the current
 * reference week and pushes it — via the same offline queue + audited
 * `timekpra` client the standing push uses (a distinct `policy.push.exceptions`
 * kind whose executor re-reads the override state on every run). Because the
 * grid is keyed by ISO weekday, the tick reconciles daily so a weekday slot an
 * override touched (this Tuesday) can never outlive the override onto the next
 * same weekday (next Tuesday) — the reconcile restores the standing slot well
 * within the seven-day horizon, and an override that has expired resolves back
 * to the standing grid (the revert) automatically.
 *
 * Modelled on `transport/reapply/scheduler.ts` and the offline-queue drainer:
 * all remote/DB/clock seams are injected, overlapping runs are suppressed
 * (croner `protect`), and one user's unexpected error is isolated so it never
 * aborts the rest of the pass. It is started by `createPolicyPushTransport` only
 * when the live SSH transport exists (like the drainer), and stopped on dispose.
 *
 * License boundary: none touched — croner (MIT) + Drizzle over the policy store;
 * the push runs over the existing SSH-subprocess `timekpra` client via the
 * injected executor. No GPL code is linked in-process (`CLAUDE.md` → "License
 * boundaries").
 */
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";

import type { PolicyDb } from "../../policy/db.js";
import { gatherUserExceptions, gatherUserScheduleRules } from "../../policy/group-resolution.js";
import { getUser, listUserLinks, listUsers } from "../../policy/repository.js";
import type { ExceptionInput } from "../../policy/resolve.js";
import { resolveWeeklyAllowedWindows } from "../../policy/weekly-windows.js";
import type { WeeklyAllowedWindows } from "../timekpr/allowed-hours.js";
import { pushOrEnqueue, type ActionExecutor, type NewQueuedAction } from "../queue/index.js";

/** The queue `kind` a date-specific override push is stored/dispatched under. */
export const EXCEPTION_PUSH_KIND = "policy.push.exceptions";

/** The audit `reason` every override push carries (a stable query key). */
export const EXCEPTION_PUSH_REASON = "exception.window";

/** The pino `component` tag every scheduler log line carries (#11). */
export const EXCEPTION_PUSH_LOG_COMPONENT = "transport/exception-push";

/**
 * Default cadence: reconcile every 15 minutes. An override "arrives" at a day
 * boundary (a `deny`/`allow` for a date) or is authored same-day ("adjust
 * bedtime tonight"); 15 minutes bounds how long after either the device lags,
 * without dialling every override-affected client more often than needed.
 */
export const DEFAULT_EXCEPTION_PUSH_PATTERN = "*/15 * * * *";

/**
 * How far back an expired exception still makes a user a reconcile candidate.
 * A weekly grid keyed by ISO weekday aliases across weeks, so a slot an override
 * touched must be reconciled back to standing before that weekday recurs — eight
 * days gives a full day of margin over the seven-day horizon, and covers a
 * revert that a process restart would otherwise miss.
 */
export const DEFAULT_EXCEPTION_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

/** Wiring for {@link startDateOverridePush}. */
export interface DateOverridePushOptions {
  /** The shared policy-store handle candidate users + overrides are read from. */
  readonly db: PolicyDb;
  /**
   * The include-exceptions push executor (`createPolicyPushExecutor({
   * includeExceptions: true })`). `pushOrEnqueue` drives it directly online and
   * the offline-queue drainer replays it — the same code path — so a queued
   * override re-resolves the current override state when the client reconnects.
   */
  readonly executor: ActionExecutor;
  /** Server-default timezone for users with no `tz` override. */
  readonly defaultTz: string;
  /** Base logger; a `transport/exception-push` child is derived for the job. */
  readonly log: FastifyBaseLogger;
  /** croner pattern; defaults to {@link DEFAULT_EXCEPTION_PUSH_PATTERN}. */
  readonly pattern?: string;
  /** Clock seam; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Expired-override candidacy lookback; defaults to {@link DEFAULT_EXCEPTION_LOOKBACK_MS}. */
  readonly lookbackMs?: number;
}

/** A running scheduler the caller can kick manually or stop on shutdown. */
export interface DateOverridePushHandle {
  /** Run one reconcile pass now (also what each cron tick invokes). */
  tick(): Promise<void>;
  /** Stop the schedule permanently (e.g. on `app.close()`). */
  stop(): void;
}

/** A stable, order-independent signature of a weekly allowed-hours grid. */
function weeklySignature(weekly: WeeklyAllowedWindows): string {
  const days: string[] = [];
  for (const weekday of [1, 2, 3, 4, 5, 6, 7] as const) {
    const windows = weekly.get(weekday) ?? [];
    days.push(windows.map((w) => `${w.start}-${w.end}`).join(","));
  }
  return days.join("|");
}

/**
 * Start the date-specific override enforcement push scheduler and return a
 * handle.
 *
 * Each tick walks the supervised users, and for any with a date-specific
 * override active (or one that expired within the lookback) computes the
 * exception-inclusive weekly grid. It pushes only when that grid differs from
 * what it last pushed for the user (change-detection), fanning out to every
 * client the user is on via the offline queue; once an override lapses the grid
 * equals the standing grid again and one final push reverts the device. The
 * first pass after start reconciles every candidate unconditionally, so a
 * restart re-asserts active overrides and clears any that expired while down.
 */
export function startDateOverridePush(options: DateOverridePushOptions): DateOverridePushHandle {
  const { db, executor, defaultTz, log } = options;
  const pattern = options.pattern ?? DEFAULT_EXCEPTION_PUSH_PATTERN;
  const now = options.now ?? ((): Date => new Date());
  const lookbackMs = options.lookbackMs ?? DEFAULT_EXCEPTION_LOOKBACK_MS;
  const child = log.child({ component: EXCEPTION_PUSH_LOG_COMPONENT });

  /**
   * The exception-inclusive grid signature we last initiated a push for, per
   * user. Present only for users with a currently-material override; pruned once
   * an override lapses and the revert has been pushed, so it stays bounded to
   * actively-overridden users (lost on restart — the first tick reconciles).
   */
  const pushedSignature = new Map<number, string>();
  let firstPass = true;

  /** Fan a desired-state push out to every client the user is on. */
  async function pushToClients(userId: number): Promise<void> {
    for (const link of listUserLinks(db, userId)) {
      const action: NewQueuedAction = {
        clientId: link.clientId,
        // Same coalesce key as the standing push: an override push and a standing
        // push are the same target's latest desired state, so they supersede one
        // another (the queue coalesces on `(clientId, coalesceKey)`), and the
        // winner's `kind` selects the executor.
        coalesceKey: `user:${userId}`,
        kind: EXCEPTION_PUSH_KIND,
        payload: { userId, reason: EXCEPTION_PUSH_REASON, detail: {} },
      };
      try {
        const outcome = await pushOrEnqueue(db, action, executor);
        child.debug(
          { userId, clientId: link.clientId, status: outcome.status },
          "date-override push dispatched",
        );
      } catch (error) {
        // `pushOrEnqueue` rethrows only non-retriable failures (a bad command —
        // replaying it unchanged won't help); a retriable/offline push is queued
        // for the drainer instead. Log and move on so one client can't abort the
        // fan-out; a later tick re-pushes if the desired state still differs.
        child.warn({ userId, clientId: link.clientId, err: error }, "date-override push failed");
      }
    }
  }

  /** Reconcile one user's override state; returns whether a push was issued. */
  async function reconcileUser(userId: number, reference: Date): Promise<void> {
    const exceptions = gatherUserExceptions(db, userId);
    const relevant: ExceptionInput[] = exceptions.filter(
      (e) => e.expiresAt.getTime() >= reference.getTime() - lookbackMs,
    );
    const tracked = pushedSignature.has(userId);
    // Nothing to enforce and nothing outstanding to revert.
    if (relevant.length === 0 && !tracked) return;

    const tz = getUser(db, userId)?.tz ?? defaultTz;
    const schedules = gatherUserScheduleRules(db, userId);
    const desiredSig = weeklySignature(
      resolveWeeklyAllowedWindows({ schedules, tz, reference, exceptions: relevant }),
    );
    const standingSig = weeklySignature(resolveWeeklyAllowedWindows({ schedules, tz, reference }));
    const materiallyActive = desiredSig !== standingSig;
    const prev = pushedSignature.get(userId);

    let shouldPush: boolean;
    if (firstPass) {
      // Reconcile every candidate after a restart: re-assert active overrides and
      // revert any that expired (device may still hold a stale override grid).
      shouldPush = true;
    } else if (materiallyActive) {
      shouldPush = desiredSig !== prev;
    } else {
      // Desired == standing: push only to revert an override we previously pushed.
      shouldPush = prev !== undefined && prev !== desiredSig;
    }
    if (!shouldPush) return;

    await pushToClients(userId);
    if (materiallyActive) {
      pushedSignature.set(userId, desiredSig);
      child.info({ userId }, "date-specific override pushed");
    } else {
      // Reverted to standing — nothing left to track for this user.
      pushedSignature.delete(userId);
      child.info({ userId }, "date-specific override reverted to standing policy");
    }
  }

  const tick = async (): Promise<void> => {
    const reference = now();
    for (const user of listUsers(db)) {
      try {
        await reconcileUser(user.id, reference);
      } catch (error) {
        // One user's unexpected failure must not abort the rest of the pass.
        child.error({ userId: user.id, err: error }, "date-override reconcile error");
      }
    }
    firstPass = false;
  };

  const job = new Cron(pattern, { name: "date-override-push", protect: true }, tick);

  return {
    tick,
    stop: () => job.stop(),
  };
}
