/**
 * Periodic re-apply (tamper-reversion) barrel (#93): the croner job that
 * reconciles enrolled clients back to their policy-derived desired state by
 * re-running the Phase-6 Ansible playbooks, auditing each pass and backing off
 * persistently failing clients.
 *
 * Like `transport/queue`'s drainer, the live start is wired by the caller once
 * the first-run venv (#39) and the playbooks (#90/#91/#92) exist; it is not
 * started inside `buildApp` here.
 */
export const moduleName = "transport/reapply";

export {
  DEFAULT_REAPPLY_PATTERN,
  DEFAULT_REAPPLY_BACKOFF,
  DEFAULT_REAPPLY_PLATFORMS,
  REAPPLY_LOG_COMPONENT,
  REAPPLY_AUDIT_REASON,
  startPeriodicReapply,
  type PeriodicReapplyOptions,
  type PeriodicReapplyHandle,
  type ReapplyBackoff,
} from "./scheduler.js";
export type { ClientLoader, ReachabilityProbe, ReapplyTarget } from "./types.js";
