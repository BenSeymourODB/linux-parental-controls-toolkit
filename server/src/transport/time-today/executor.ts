/**
 * The queued same-day-adjustment {@link ActionExecutor} (#274).
 *
 * Replays a `timekpr.time-today` action (enqueued for a client that was offline
 * when the admin clicked) idempotently, as the at-least-once queue contract
 * (`queue/drainer.ts`) requires:
 *
 * - **Absolute target.** It always issues `--settimeleft = T`, never an additive
 *   delta, so a replay re-asserts the same end state rather than adding twice.
 * - **Deferred resolve.** For a `+`/`-` delta the absolute `T` can only be
 *   computed once the client is reachable (it needs the live remaining time), so
 *   the executor reads `--userinfo` (`TIME_LEFT_DAY`), computes `T = max(0,
 *   remaining ± seconds)`, **persists `T` back to its own row first**, then
 *   issues the set. A crash between the set and `markDrained` replays the *same*
 *   persisted `T`. (`=` actions carry `T` from enqueue and skip the read.)
 * - **Rollover expiry.** A nudge whose `targetDate` has passed (in the user's
 *   effective timezone) is a no-op, so a stale adjustment never lands a day late.
 *
 * Read/parse failures of `--userinfo` reject with a plain `Error` (non-retriable)
 * so the drainer dead-letters the row rather than retrying a request it can't
 * satisfy; SSH unreachable/timeout from the injected client propagates with its
 * retriable flag intact, keeping the action queued.
 *
 * License boundary: none touched — orchestration over Drizzle + the injected
 * `timekpra` client, which execs over the existing SSH subprocess facade. No GPL
 * code is linked in-process (`CLAUDE.md` → "License boundaries").
 */
import { localCalendarDate } from "../../policy/budget-window.js";
import type { PolicyDb } from "../../policy/db.js";
import { getClient, getUser, type ClientRow } from "../../policy/repository.js";
import { updateActionPayload } from "../queue/repository.js";
import type { ActionExecutor, QueuedAction } from "../queue/types.js";
import type { TimeLeftOperation } from "../timekpr/commands.js";
import { formatCalendarDate, timeTodayPayloadSchema } from "./queued.js";

/** `timekpra --userinfo` key carrying the user's remaining seconds for today. */
const TIME_LEFT_DAY_KEY = "TIME_LEFT_DAY";

/**
 * The slice of {@link import("../timekpr/client.js").TimekprClient} the executor
 * drives. Declared structurally (the `--userinfo` result reduced to its `get`)
 * so the real client satisfies it and a test passes a recording fake without an
 * `as` cast — the same pattern as `PolicyPushClient`.
 */
export interface TimeTodayDeferredClient {
  getUserInfo(): Promise<{ get(key: string): string | undefined }>;
  setTimeLeft(operation: TimeLeftOperation, seconds: number): Promise<unknown>;
}

/** Addressing for the {@link TimeTodayExecutorClientFactory}. */
export interface TimeTodayExecutorTarget {
  readonly client: ClientRow;
  readonly username: string;
  readonly userId: number;
}

/** Builds the {@link TimeTodayDeferredClient} for one queued adjustment replay. */
export type TimeTodayExecutorClientFactory = (
  target: TimeTodayExecutorTarget,
) => TimeTodayDeferredClient;

/** Construction options for {@link createTimeTodayExecutor}. */
export interface TimeTodayExecutorOptions {
  readonly db: PolicyDb;
  readonly buildClient: TimeTodayExecutorClientFactory;
  /** Server-default timezone for users with no `tz` (for rollover expiry). */
  readonly defaultTz: string;
  /** Clock for the rollover-expiry check; overridable in tests. */
  readonly now?: () => Date;
}

/** Parse a `TIME_LEFT_DAY` value to a non-negative integer seconds count. */
function parseRemaining(raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error(`timekpra --userinfo: missing ${TIME_LEFT_DAY_KEY}`);
  }
  const seconds = Number(raw.trim());
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error(
      `timekpra --userinfo: ${TIME_LEFT_DAY_KEY} is not a non-negative integer: ${JSON.stringify(raw)}`,
    );
  }
  return seconds;
}

/**
 * Build the queued same-day-adjustment {@link ActionExecutor}. Only handles the
 * {@link TIME_TODAY_KIND}; compose it with the policy-push executor via
 * {@link import("../queue/composite.js").compositeExecutor} for the drainer.
 */
export function createTimeTodayExecutor(options: TimeTodayExecutorOptions): ActionExecutor {
  const { db, buildClient, defaultTz } = options;
  const now = options.now ?? ((): Date => new Date());

  return async function execute(action: QueuedAction): Promise<void> {
    const payload = timeTodayPayloadSchema.parse(action.payload);

    // The client may have been deleted between enqueue and replay.
    const client = getClient(db, action.clientId);
    if (client === undefined) return;

    const user = getUser(db, payload.userId);
    const tz = user?.tz ?? defaultTz;

    // Rollover expiry: a same-day nudge whose target day has passed is dropped
    // (resolve as a no-op) rather than landing a day late.
    const today = formatCalendarDate(localCalendarDate(now(), tz));
    if (today > payload.targetDate) return;

    const timekpr = buildClient({ client, username: payload.osUsername, userId: payload.userId });

    let target = payload.resolvedTargetSeconds;
    if (target === null) {
      // Deferred resolve: read the live remaining time, compute the absolute
      // target, and persist it *before* the set so a replay re-issues the same
      // value. The row id is always present on a drained action.
      if (action.id === undefined) {
        throw new Error("time-today: cannot persist a deferred-resolved target without a row id");
      }
      const info = await timekpr.getUserInfo();
      const remaining = parseRemaining(info.get(TIME_LEFT_DAY_KEY));
      const signed = payload.operation === "-" ? -payload.seconds : payload.seconds;
      target = Math.max(0, remaining + signed);
      updateActionPayload(db, action.id, { ...payload, resolvedTargetSeconds: target });
    }

    await timekpr.setTimeLeft("=", target);
  };
}
