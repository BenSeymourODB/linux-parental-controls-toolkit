/**
 * Timekpr-nExT transport: builds and runs the `timekpra` admin CLI over the SSH
 * facade as a subprocess. Translates transport-level session-limit / allowed-
 * hours / PlayTime inputs into `timekpra` invocations and confirms them by
 * parsing stdout.
 *
 * License boundary: never link Timekpr-nExT (GPL) code in-process — we only run
 * its CLI over SSH and parse stdout. See `docs/licensing-analysis.md`,
 * `./client.ts`, and `../ssh/`.
 */
export const moduleName = "transport/timekpr";

export { TimekprArgumentError } from "./errors.js";
export {
  ALL_DAYS,
  buildSetAllowedDays,
  buildSetAllowedHours,
  buildSetPlayTimeActivities,
  buildSetPlayTimeAllowedDays,
  buildSetPlayTimeEnabled,
  buildSetPlayTimeLimitOverride,
  buildSetPlayTimeUnaccountedIntervalsEnabled,
  buildSetPlayTimeLimits,
  buildSetTimeLimits,
  buildSetTimeLimitMonth,
  buildSetTimeLimitWeek,
  buildUserInfo,
  assertUsername,
  type AllowedHour,
  type AllowedHoursDay,
  type IsoWeekday,
  type PlayTimeActivity,
} from "./commands.js";
export {
  DEFAULT_TIMEKPRA_BINARY,
  TimekprClient,
  type TimekprClientOptions,
  type TimekprTransport,
} from "./client.js";
export { TimekprUserInfo, timekprUserInfoSchema } from "./userinfo.js";
export {
  allowedWindowsToAllowedHours,
  buildWeeklyAllowedHoursCommands,
  type TimeWindow,
  type WeeklyAllowedWindows,
} from "./allowed-hours.js";
