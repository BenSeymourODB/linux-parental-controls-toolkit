/**
 * Managed-mode AdGuard Home health poller (#283).
 *
 * A croner job (`CLAUDE.md` → "Scheduling: croner for in-process periodic
 * jobs") that re-runs {@link AdGuardService.runPreflight} on a cadence so a
 * crash/restart of the supervised AdGuard Home instance (#96) becomes visible in
 * the admin UI via `GET /api/dns`, rather than going stale at the single
 * startup probe. The supervisor exposes a status snapshot but no event hook, so
 * polling is the integration path.
 *
 * To avoid per-tick log spam (the poll runs every 30 s), only **health
 * transitions** are logged: `info` on recovery to `ok`, `error` otherwise — the
 * loud-on-failure behaviour `docs/server-deployment.md` → "First-run setup"
 * wants, without a line every tick.
 *
 * Like `transport/reapply/scheduler.ts` and `transport/queue/scheduler.ts`, this
 * is wired by its caller (`main.ts`, after `listen`) rather than inside
 * `buildApp`, so constructing the app — including every test — starts no timer.
 *
 * License boundary: none touched — croner (MIT) + the injected service seam. The
 * service still speaks to AdGuard only over its REST API.
 */
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";

import type { DnsStatus, PreflightLogger } from "./service.js";

/**
 * Default cadence: every 30 seconds. A managed-instance crash is reverted by the
 * supervisor's restart-with-backoff within seconds, so a 30 s poll surfaces the
 * blip (and the recovery) promptly without dialing localhost needlessly often.
 */
export const DEFAULT_ADGUARD_HEALTH_POLL_PATTERN = "*/30 * * * * *";

/** The pino `component` tag every poller log line carries (#11). */
export const ADGUARD_HEALTH_LOG_COMPONENT = "transport/adguard";

/**
 * The minimal {@link AdGuardService} surface the poller drives. Structural so a
 * test can pass a recording fake without constructing the full service.
 */
export interface PollableAdGuardService {
  /** The last-observed status (read once to seed the transition baseline). */
  readonly status: DnsStatus;
  /** Re-probe and return the fresh status. */
  runPreflight(logger?: PreflightLogger): Promise<DnsStatus>;
}

/** Wiring for {@link startAdGuardHealthPoll}. */
export interface AdGuardHealthPollOptions {
  /** The managed-mode service to re-probe each tick. */
  readonly service: PollableAdGuardService;
  /** Base logger; a `transport/adguard` child is derived for the poller's lines. */
  readonly log: FastifyBaseLogger;
  /** croner pattern; defaults to {@link DEFAULT_ADGUARD_HEALTH_POLL_PATTERN}. */
  readonly pattern?: string;
}

/** A running poller the caller can kick manually or stop on shutdown. */
export interface AdGuardHealthPollHandle {
  /** Run one probe now (also what each cron tick invokes). */
  tick(): Promise<void>;
  /** Stop the schedule permanently (e.g. on `app.close()`). */
  stop(): void;
}

/**
 * Start the managed-mode health poller and return a handle.
 *
 * Overlapping runs are suppressed (croner `protect`), so a slow probe can't
 * stack up behind the schedule. `tick()` never rejects — {@link
 * PollableAdGuardService.runPreflight} swallows its own failures into the status.
 */
export function startAdGuardHealthPoll(options: AdGuardHealthPollOptions): AdGuardHealthPollHandle {
  const pattern = options.pattern ?? DEFAULT_ADGUARD_HEALTH_POLL_PATTERN;
  const child = options.log.child({ component: ADGUARD_HEALTH_LOG_COMPONENT });
  let lastHealth = options.service.status.health;

  const tick = async (): Promise<void> => {
    const status = await options.service.runPreflight();
    if (status.health === lastHealth) return;
    lastHealth = status.health;
    const fields = {
      event: "adguard_managed_health",
      health: status.health,
      baseUrl: status.baseUrl,
    };
    if (status.health === "ok") {
      child.info(fields, "managed AdGuard Home healthy");
    } else {
      child.error(fields, status.detail ?? `managed AdGuard Home health: ${status.health}`);
    }
  };

  const job = new Cron(pattern, { name: "adguard-health-poll", protect: true }, tick);

  return {
    tick,
    stop: () => job.stop(),
  };
}
