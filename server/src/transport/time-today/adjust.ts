/**
 * The "Add time today" adjustment service (#257, Phase 4 transport).
 *
 * A manual admin lever that adjusts a supervised user's **remaining time for
 * today** on the client(s) they're linked to — `timekpra --settimeleft` — with
 * no change to the standing daily `Budget`. It is the pre-Grant-ledger bonus /
 * unlock affordance (#185); the durable, auditable, idempotent Grant model is
 * Phase 10.
 *
 * **Online-only, by design — not routed through the offline queue (#84).** The
 * queue is at-least-once with coalescing and therefore requires *idempotent*
 * executors (see `queue/drainer.ts`); the standing policy push satisfies that by
 * setting *absolute* limits. An additive `--settimeleft +N` is **not**
 * idempotent — a crash-then-replay would double-apply and coalescing two queued
 * adjustments would drop one. This lever is also an *ephemeral same-day* nudge
 * (it does not persist past the daily rollover), so an adjustment queued against
 * an offline client is likely moot by the time it reconnects. So this applies
 * synchronously to each reachable client and reports a per-client `unreachable`
 * outcome for the rest, rather than enqueuing. Every attempt is still recorded
 * in the audit log (#85) because the injected client runs over the
 * `AuditingTransport`.
 *
 * Unlike the fire-and-forget `PolicyPushStub.push`, this is **awaitable**: the
 * admin gets a per-client result back so the UI can say what actually happened.
 *
 * License boundary: none touched — orchestration over Drizzle + an injected
 * `timekpra` client that execs over the existing SSH subprocess facade. No GPL
 * code is linked in-process (`CLAUDE.md` → "License boundaries").
 */
import { localCalendarDate } from "../../policy/budget-window.js";
import type { PolicyDb } from "../../policy/db.js";
import { getClient, getUser, listUserLinks, type ClientRow } from "../../policy/repository.js";
import { enqueue } from "../queue/repository.js";
import { isRetriable } from "../queue/types.js";
import type { TimeLeftOperation } from "../timekpr/commands.js";
import { formatCalendarDate, queuedActionForOfflineAdjustment } from "./queued.js";

/**
 * The slice of {@link import("../timekpr/client.js").TimekprClient} the service
 * drives. Declared structurally so the real client satisfies it and a test can
 * pass a recording fake without an `as` cast — the same pattern as
 * `PolicyPushClient`.
 */
export interface TimeTodayClient {
  setTimeLeft(operation: TimeLeftOperation, seconds: number): Promise<unknown>;
}

/** Addressing for the {@link TimeTodayClientFactory}. */
export interface TimeTodayClientTarget {
  /** The enrolled client the command is dispatched to. */
  readonly client: ClientRow;
  /** The supervised Linux account `timekpra` acts on (from the user↔client link). */
  readonly username: string;
  /** The affected supervised user's id (audit attribution). */
  readonly userId: number;
}

/**
 * Builds the {@link TimeTodayClient} for one (client, user) adjustment.
 * Production returns a `TimekprClient` over the audited SSH transport bound to
 * the client's `SshTarget`; tests return a recording fake.
 */
export type TimeTodayClientFactory = (target: TimeTodayClientTarget) => TimeTodayClient;

/** A single same-day remaining-time adjustment request. */
export interface TimeTodayAdjustment {
  /** The supervised user whose remaining time is adjusted. */
  readonly userId: number;
  /** `+`/`-` for an additive delta, `=` to set today's remaining time outright. */
  readonly operation: TimeLeftOperation;
  /** A non-negative number of seconds (the magnitude of the delta, or the target). */
  readonly seconds: number;
  /**
   * Restrict the adjustment to one client the user is linked to; when omitted it
   * applies to **every** client the user is linked to.
   */
  readonly clientId?: number;
}

/**
 * Per-client outcome of an adjustment attempt. `queued` is reported only when
 * {@link AdjustTimeTodayOptions} is supplied (the offline-queue variant, #274):
 * a client unreachable at request time has the adjustment durably queued for
 * idempotent replay on reconnect, instead of the bare `unreachable` the
 * online-only #257 path returns.
 */
export type ClientAdjustmentStatus = "applied" | "queued" | "unreachable" | "failed";

/** What happened on one client for an adjustment. */
export interface ClientAdjustmentResult {
  /** The client the adjustment targeted. */
  readonly clientId: number;
  /** The supervised Linux account on that client. */
  readonly osUsername: string;
  /** Whether the command applied, the host was unreachable, or it failed. */
  readonly status: ClientAdjustmentStatus;
  /** A secret-free error summary for a non-`applied` outcome. */
  readonly error?: string;
}

/** The outcome of an adjustment across all targeted clients. */
export interface TimeTodayResult {
  readonly results: ClientAdjustmentResult[];
}

/**
 * Enables the offline-queue variant (#274). When supplied, a client that is
 * unreachable at request time has the adjustment **durably queued** (resolved to
 * an idempotent absolute target on reconnect) and reported as `queued`; omitted,
 * the adjustment is online-only (#257) and an unreachable client is `unreachable`.
 */
export interface AdjustTimeTodayOptions {
  /** Server-default timezone for users with no `tz` (for the rollover `targetDate`). */
  readonly defaultTz: string;
  /** Clock for the `targetDate`; overridable in tests. Defaults to `new Date()`. */
  readonly now?: () => Date;
}

/** Distinguishes "no such link" (a caller error) from a per-client push failure. */
export class TimeTodayTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeTodayTargetError";
  }
}

/** Render a thrown value as a secret-free message for the per-client result. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply a same-day time adjustment to each of the user's linked clients (or the
 * single `clientId` requested), online-only.
 *
 * Resolution + targeting errors throw {@link TimeTodayTargetError} (the caller
 * maps these to a 4xx): the user has no links, or the requested `clientId` is
 * not one of them. A per-client *push* failure never throws — it is captured in
 * that client's {@link ClientAdjustmentResult} (`unreachable` for the retriable
 * SSH taxonomy, `failed` otherwise) so a partial fan-out still returns a full
 * report.
 */
export async function adjustTimeToday(
  db: PolicyDb,
  buildClient: TimeTodayClientFactory,
  adjustment: TimeTodayAdjustment,
  options?: AdjustTimeTodayOptions,
): Promise<TimeTodayResult> {
  const { userId, operation, seconds, clientId } = adjustment;

  const links = listUserLinks(db, userId);
  const targets = clientId === undefined ? links : links.filter((l) => l.clientId === clientId);

  if (clientId !== undefined && targets.length === 0) {
    throw new TimeTodayTargetError(`User ${userId} is not linked to client ${clientId}`);
  }
  if (targets.length === 0) {
    throw new TimeTodayTargetError(`User ${userId} is not linked to any client; nothing to adjust`);
  }

  const results: ClientAdjustmentResult[] = [];
  for (const link of targets) {
    // The client could have been deleted between the link read and here; skip
    // a dangling link rather than failing the whole fan-out.
    const client = getClient(db, link.clientId);
    if (client === undefined) {
      results.push({
        clientId: link.clientId,
        osUsername: link.osUsername,
        status: "failed",
        error: `Client ${link.clientId} no longer exists`,
      });
      continue;
    }

    const timekpr = buildClient({ client, username: link.osUsername, userId });
    try {
      await timekpr.setTimeLeft(operation, seconds);
      results.push({ clientId: link.clientId, osUsername: link.osUsername, status: "applied" });
    } catch (error) {
      // A retriable (host-unreachable) failure is the queue's normal path: when
      // the offline variant is enabled, durably queue an idempotent absolute
      // adjustment for replay on reconnect rather than dropping the nudge. A
      // non-retriable failure (the command itself is wrong) is never queued.
      if (options !== undefined && isRetriable(error)) {
        const now = options.now ?? ((): Date => new Date());
        const tz = getUser(db, userId)?.tz ?? options.defaultTz;
        const targetDate = formatCalendarDate(localCalendarDate(now(), tz));
        enqueue(
          db,
          queuedActionForOfflineAdjustment({
            clientId: link.clientId,
            userId,
            osUsername: link.osUsername,
            targetDate,
            operation,
            seconds,
          }),
        );
        results.push({ clientId: link.clientId, osUsername: link.osUsername, status: "queued" });
        continue;
      }
      results.push({
        clientId: link.clientId,
        osUsername: link.osUsername,
        status: isRetriable(error) ? "unreachable" : "failed",
        error: errorMessage(error),
      });
    }
  }

  return { results };
}
