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
 * grid is keyed by ISO weekday, the reconcile restores an override-touched
 * weekday slot to standing once the override's week rolls past — well within the
 * seven-day aliasing horizon for a mid-week override. (A Monday override is the
 * edge: its revert can only fire once the reference instant reaches the *next*
 * Monday, so the stale slot can linger for up to one cron interval into that
 * aliasing Monday before the tick reverts it.) An override that has expired
 * resolves back to the standing grid (the revert) automatically.
 *
 * While an override is materially active the tick **re-asserts it every pass**,
 * not only on change: the desired grid can be clobbered on the device
 * out-of-band by a standing policy push (which resolves the exception-free grid
 * and shares this push's coalesce key), and the scheduler cannot observe that,
 * so idempotent re-pushing bounds any such clobber to at most one cron interval.
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
 * How far back an expired exception still makes a user a **steady-state**
 * reconcile candidate. A weekly grid keyed by ISO weekday aliases across weeks,
 * so a slot an override touched must be reconciled back to standing before that
 * weekday recurs — eight days gives a full day of margin over the seven-day
 * horizon. (A restart reconciles *any* user with an exception row regardless of
 * age — see the first-pass branch in `reconcileUser` — so a long outage past
 * this window still self-heals once on the next start.)
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
   * Users we are currently enforcing an override for. Used only to fire the
   * revert push exactly once when an override lapses (a tracked user whose grid
   * has fallen back to standing), so the set stays bounded to actively-overridden
   * users. It is deliberately **not** a change-detection cache: while an override
   * is materially active we re-push every tick (see {@link reconcileUser}) so an
   * out-of-band clobber — e.g. a standing policy push for an unrelated budget
   * edit, which resolves the exception-free grid and shares this push's coalesce
   * key — self-heals within one cron interval rather than being lost until the
   * override changes. Lost on restart; the first tick reconciles.
   */
  const tracking = new Set<number>();
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

  /** Reconcile one user's override state for this pass. */
  async function reconcileUser(userId: number, reference: Date): Promise<void> {
    const exceptions = gatherUserExceptions(db, userId);
    const tracked = tracking.has(userId);

    // Candidate gate. On the first pass after start (empty tracking set) reconcile
    // every user with *any* exception row, so a restart reverts even an override
    // that expired during a long outage (the device may still hold its stale
    // weekly-grid slot). In steady state, a user is a candidate only if they have
    // an exception recent enough to still matter (within the lookback) or one we
    // are already enforcing (so the revert still fires).
    if (firstPass) {
      if (exceptions.length === 0) return;
    } else {
      const recent = exceptions.some(
        (e) => e.expiresAt.getTime() >= reference.getTime() - lookbackMs,
      );
      if (!recent && !tracked) return;
    }

    const tz = getUser(db, userId)?.tz ?? defaultTz;
    const schedules = gatherUserScheduleRules(db, userId);
    // Build both grids for the current reference week. All exceptions are passed
    // to the resolver, which date-gates each to the days it actually covers, so
    // an expired override contributes nothing and the grid falls back to standing.
    const overrideGrid = resolveWeeklyAllowedWindows({ schedules, tz, reference, exceptions });
    const standingGrid = resolveWeeklyAllowedWindows({ schedules, tz, reference });
    const materiallyActive = weeklySignature(overrideGrid) !== weeklySignature(standingGrid);

    let shouldPush: boolean;
    if (materiallyActive) {
      // Re-assert every tick (not just on change): the desired grid can be
      // clobbered on the device out-of-band by a standing push, which this
      // scheduler cannot observe, so idempotently re-pushing bounds any clobber
      // to at most one cron interval. Cheap — only actively-overridden users.
      shouldPush = true;
    } else {
      // Grid has fallen back to standing: push the revert exactly once, when we
      // were enforcing an override or are doing the first-pass restart sweep.
      shouldPush = tracked || firstPass;
    }
    if (!shouldPush) return;

    await pushToClients(userId);
    if (materiallyActive) {
      tracking.add(userId);
      child.info({ userId }, "date-specific override pushed");
    } else {
      // Reverted to standing — nothing left to track for this user.
      tracking.delete(userId);
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
