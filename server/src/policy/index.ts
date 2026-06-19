/** Policy model, persistence (Drizzle/SQLite), and immutable grant ledger. */
export const moduleName = "policy";

export {
  type BudgetWindowBounds,
  type TimezoneChange,
  InvalidTimeZoneError,
  isValidTimeZone,
  assertTimeZone,
  resolveEffectiveTz,
  windowContaining,
  effectiveWindow,
  localCalendarDate,
  localTimeOfDayMinutes,
  isoWeekday,
  localDayBounds,
} from "./budget-window.js";

export {
  type BudgetInput,
  type GrantInput,
  type AllowedWindow,
  type ActiveRule,
  type ActivityQuota,
  type EffectivePolicy,
  type EffectivePolicyInput,
  isRuleActiveAt,
  ruleActiveAt,
  effectivePolicy,
} from "./resolve.js";

export {
  type ScheduleRule,
  type RuleActivePredicate,
  type ShadowFinding,
  ReorderMismatchError,
  byOrdinal,
  resolveEffectiveRule,
  resolveEffectiveAction,
  nextOrdinal,
  reorder,
  findShadowedRules,
} from "./schedule-precedence.js";
