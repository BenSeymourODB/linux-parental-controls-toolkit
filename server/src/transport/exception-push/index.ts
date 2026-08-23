/**
 * Date-specific override enforcement push (#399, Phase 13): the croner scheduler
 * that pushes a user's active date-specific overrides to their client's
 * `timekpra` allowed-hours when the override's window arrives, and reverts to
 * the standing recurring policy once it lapses. See {@link ./scheduler.ts} and
 * ADR 0012 §3.
 */
export const moduleName = "transport/exception-push";

export {
  DEFAULT_EXCEPTION_LOOKBACK_MS,
  DEFAULT_EXCEPTION_PUSH_PATTERN,
  EXCEPTION_PUSH_KIND,
  EXCEPTION_PUSH_LOG_COMPONENT,
  EXCEPTION_PUSH_REASON,
  startDateOverridePush,
  type DateOverridePushHandle,
  type DateOverridePushOptions,
} from "./scheduler.js";
