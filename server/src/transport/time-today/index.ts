/**
 * "Add time today" transport (#257): an awaitable, online-only admin lever that
 * adjusts a supervised user's remaining time for today via `timekpra
 * --settimeleft`, independent of the standing daily limit. See `./adjust.ts` for
 * the design rationale (why it is not routed through the offline queue).
 *
 * License boundary: none touched — execs `timekpra` over the SSH subprocess
 * facade; no GPL code linked in-process.
 */
export const moduleName = "transport/time-today";

export {
  adjustTimeToday,
  TimeTodayTargetError,
  type ClientAdjustmentResult,
  type ClientAdjustmentStatus,
  type TimeTodayAdjustment,
  type TimeTodayClient,
  type TimeTodayClientFactory,
  type TimeTodayClientTarget,
  type TimeTodayResult,
} from "./adjust.js";
