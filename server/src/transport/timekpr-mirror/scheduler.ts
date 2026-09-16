/**
 * Scheduled upstream fetch/refresh for the managed `timekpr-next` mirror
 * (#392, epic #389).
 *
 * A croner job (`CLAUDE.md` → "Scheduling: croner for in-process periodic
 * jobs") that, each tick, brings `/data/apt/timekpr/` current with the upstream
 * `.deb` via {@link refreshTimekprMirror}. It runs on the server, in the
 * background, **off every client's install/enrol critical path** — so a slow or
 * unreachable Launchpad never blocks an enrolment (issue #392; epic #389
 * "Problem"). A failed refresh is logged and the job is backed off with
 * exponential delay so a persistently unreachable upstream doesn't retry every
 * tick; a later successful pass clears the backoff.
 *
 * Wired by the caller (`main.ts`) only in `managed` mode, after `listen` — like
 * `startAdGuardHealthPoll` and `startPeriodicReapply`, building the app starts no
 * timer. `external` mode points clients at a repo the homelab already hosts and
 * `disabled` does nothing, so neither fetches.
 *
 * License boundary: none touched — croner (MIT) + the injected {@link
 * refreshTimekprMirror} seam, which only fetches a `.deb` into `/data`. Nothing
 * links, imports, or vendors GPL code (ADR 0011; `docs/licensing-analysis.md`).
 */
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";

import { refreshTimekprMirror, type RefreshConfig, type RefreshDeps } from "./refresh.js";

/**
 * Default cadence: refresh daily at 03:00. Upstream `timekpr-next` releases are
 * infrequent and the fetch is off the client critical path, so a tight cadence
 * would only dial Launchpad more often for no benefit.
 */
export const DEFAULT_REFRESH_PATTERN = "0 3 * * *";

/** The pino `component` tag every scheduler log line carries (#11). */
export const REFRESH_LOG_COMPONENT = "transport/timekpr-mirror";

/** Exponential backoff bounds after a failed refresh. */
export interface RefreshBackoff {
  /** Delay after the first failure; doubles each consecutive failure. */
  readonly baseMs: number;
  /** Ceiling the doubling is clamped to. */
  readonly maxMs: number;
}

/** Default backoff: 5 min after the first failure, doubling up to 6 hours. */
export const DEFAULT_REFRESH_BACKOFF: RefreshBackoff = {
  baseMs: 5 * 60 * 1000,
  maxMs: 6 * 60 * 60 * 1000,
};

/** Wiring for {@link startTimekprMirrorRefresh}. */
export interface TimekprMirrorRefreshOptions {
  /** The managed mirror config slice (dataDir, package, optional pinned version). */
  readonly config: RefreshConfig;
  /** Base logger; a `transport/timekpr-mirror` child is derived for the job's lines. */
  readonly log: FastifyBaseLogger;
  /** croner pattern; defaults to {@link DEFAULT_REFRESH_PATTERN}. */
  readonly pattern?: string;
  /** Backoff bounds; defaults to {@link DEFAULT_REFRESH_BACKOFF}. */
  readonly backoff?: RefreshBackoff;
  /** Clock seam for backoff scheduling; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Refresh seams (network/filesystem/retry); defaults let production hit the real deps. */
  readonly refreshDeps?: RefreshDeps;
}

/** A running scheduler the caller can kick manually or stop on shutdown. */
export interface TimekprMirrorRefreshHandle {
  /** Run one refresh pass now (also what each cron tick invokes). */
  tick(): Promise<void>;
  /** Stop the schedule permanently (e.g. on `app.close()`). */
  stop(): void;
}

/**
 * Start the mirror refresh scheduler and return a handle.
 *
 * Overlapping runs are suppressed (croner `protect`), so a slow download can't
 * stack up behind the schedule. A tick never throws: a failed refresh is caught,
 * logged, and backed off; a success clears the backoff. The caller typically
 * kicks {@link TimekprMirrorRefreshHandle.tick} once after `listen` to warm the
 * cache immediately (still off the client path).
 */
export function startTimekprMirrorRefresh(
  options: TimekprMirrorRefreshOptions,
): TimekprMirrorRefreshHandle {
  const { config, log } = options;
  const pattern = options.pattern ?? DEFAULT_REFRESH_PATTERN;
  const backoff = options.backoff ?? DEFAULT_REFRESH_BACKOFF;
  const now = options.now ?? Date.now;
  const child = log.child({ component: REFRESH_LOG_COMPONENT });

  /** Consecutive failures + the epoch-ms before which the next tick is skipped. */
  let failures = 0;
  let nextEligibleAt = 0;

  const tick = async (): Promise<void> => {
    if (now() < nextEligibleAt) {
      child.debug({ nextEligibleAt }, "timekpr mirror refresh skipped: in backoff");
      return;
    }
    try {
      const result = await refreshTimekprMirror(config, options.refreshDeps);
      failures = 0;
      nextEligibleAt = 0;
      if (result.fetched) {
        child.info(
          { version: result.version, filename: result.filename },
          "timekpr mirror refreshed",
        );
      } else {
        child.debug({ version: result.version }, "timekpr mirror already current");
      }
    } catch (error) {
      failures += 1;
      const delay = Math.min(backoff.baseMs * 2 ** (failures - 1), backoff.maxMs);
      nextEligibleAt = now() + delay;
      child.warn(
        { err: error, failures, nextRetryMs: delay },
        "timekpr mirror refresh failed; backing off",
      );
    }
  };

  const job = new Cron(pattern, { name: "timekpr-mirror-refresh", protect: true }, tick);

  return {
    tick,
    stop: () => job.stop(),
  };
}
