/**
 * The queued, offline-safe form of an "Add time today" adjustment (#274).
 *
 * #257's lever is online-only because an additive `--settimeleft +N` is not
 * idempotent, and the offline queue (#84) is at-least-once with coalescing. This
 * module is the queue-safe variant: it models the adjustment as a
 * `timekpr.time-today` action whose executor (`./executor.ts`) asserts an
 * **absolute** target (`--settimeleft = T`), which *is* idempotent on replay.
 *
 * - `=` (set outright) is offline-safe — the absolute target is the request
 *   itself, so `resolvedTargetSeconds` is filled at enqueue.
 * - `+`/`-` (delta) needs the client's current remaining time, which can only be
 *   read once the client is reachable, so it is queued with
 *   `resolvedTargetSeconds: null` and **deferred-resolved on first reconnect**.
 *
 * Each request gets a **unique** coalesce key, so two distinct same-day nudges
 * never coalesce into one (no silent drop — they both apply, latest after
 * earliest). This is the deliberate opposite of `policy.push`, whose coalesce
 * key is the *target* (a standing desired state, latest-wins).
 *
 * License boundary: none touched — plain TypeScript + zod; the actual `timekpra`
 * exec happens in the executor over the SSH subprocess facade.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { NewQueuedAction } from "../queue/types.js";
import type { TimeLeftOperation } from "../timekpr/commands.js";

/** The `kind` discriminator for queued same-day adjustments. */
export const TIME_TODAY_KIND = "timekpr.time-today";

/** The `timekpra --settimeleft` operation (`+`/`-` delta, `=` set). */
const timeLeftOperationSchema = z.enum([
  "+",
  "-",
  "=",
] as const satisfies readonly TimeLeftOperation[]);

/**
 * The persisted payload of a queued same-day adjustment. `targetDate` is the
 * adjustment's day in the user's effective timezone (`YYYY-MM-DD`); the executor
 * drops the action once that day has rolled over. `resolvedTargetSeconds` is the
 * absolute `--settimeleft =` value: known up front for `=`, and `null` for a
 * `+`/`-` delta until the executor resolves it against a live `--userinfo` read.
 */
export const timeTodayPayloadSchema = z.object({
  userId: z.number().int().positive(),
  osUsername: z.string().min(1),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  operation: timeLeftOperationSchema,
  // Upstream (`adjustTimeTodaySchema`) bounds the magnitude to one day; the
  // queue payload only needs non-negativity.
  seconds: z.number().int().min(0),
  resolvedTargetSeconds: z.number().int().min(0).nullable(),
});

/** The inferred queued same-day adjustment payload. */
export type TimeTodayPayload = z.infer<typeof timeTodayPayloadSchema>;

/** Format a `{ year, month, day }` calendar date as zero-padded `YYYY-MM-DD`. */
export function formatCalendarDate(date: { year: number; month: number; day: number }): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** The inputs needed to queue an offline same-day adjustment for one client. */
export interface OfflineAdjustment {
  readonly clientId: number;
  readonly userId: number;
  /** The supervised Linux account `timekpra` acts on. */
  readonly osUsername: string;
  /** The adjustment's day in the user's effective timezone (`YYYY-MM-DD`). */
  readonly targetDate: string;
  /** `+`/`-` additive delta, or `=` to set today's remaining outright. */
  readonly operation: z.infer<typeof timeLeftOperationSchema>;
  /** Non-negative magnitude (the delta size, or the absolute target for `=`). */
  readonly seconds: number;
}

/**
 * Build the {@link NewQueuedAction} for an offline same-day adjustment. The
 * unique coalesce key keeps two distinct nudges from collapsing; `=` resolves
 * its absolute target immediately, a delta defers it to first reconnect.
 */
export function queuedActionForOfflineAdjustment(adjustment: OfflineAdjustment): NewQueuedAction {
  const resolvedTargetSeconds = adjustment.operation === "=" ? adjustment.seconds : null;
  return {
    clientId: adjustment.clientId,
    coalesceKey: `time-today:${adjustment.userId}:${randomUUID()}`,
    kind: TIME_TODAY_KIND,
    payload: {
      userId: adjustment.userId,
      osUsername: adjustment.osUsername,
      targetDate: adjustment.targetDate,
      operation: adjustment.operation,
      seconds: adjustment.seconds,
      resolvedTargetSeconds,
    },
  };
}
