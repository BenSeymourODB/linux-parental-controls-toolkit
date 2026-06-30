/**
 * Per-activity enforcement decision logic (#98, Phase 8).
 *
 * The server-side decision that, after each telemetry rollup, detects an
 * exhausted per-activity / per-group quota and decides the target should be
 * stopped — with a cool-down so a near-boundary sample doesn't re-fire
 * (`docs/architecture.md` → "Enforcement responsibilities" → *Per-app time
 * quota (granular)*).
 *
 * Layering: {@link ./decision.ts} is the pure core (compare + cool-down);
 * {@link ./evaluate.ts} is the read-only DB seam that feeds it from the policy
 * store. The decision is *acted on* by the force-close trigger
 * ({@link ./force-close.ts}, #99): after grace it emits `enforce.force_close`
 * over the #100 event channel, or falls back to a user-scoped SSH `pkill`. Its
 * live wiring is {@link ./force-close-deps.ts}.
 */
export const moduleName = "enforcement";

export {
  decideEnforcement,
  targetKey,
  type EnforcementScope,
  type QuotaConsumption,
  type EnforcementDecisionInput,
  type EnforcementDecision,
  type EnforcementOutcome,
} from "./decision.js";

export { evaluateUserEnforcement, type EvaluateEnforcementInput } from "./evaluate.js";

export {
  ForceCloseTrigger,
  type ForceCloseClient,
  type ForceCloseActivity,
  type ForceCloseDeps,
  type ForceCloseLogger,
} from "./force-close.js";

export { buildPkillArgv } from "./force-close-pkill.js";

export {
  createForceCloseDeps,
  type CreateForceCloseDepsOptions,
  type ForceCloseEventHub,
  type ForceClosePkillTransport,
} from "./force-close-deps.js";

export {
  startEnforcementSweep,
  loadSupervisedUsers,
  DEFAULT_SWEEP_PATTERN,
  DEFAULT_COOLDOWN_SECONDS,
  SWEEP_LOG_COMPONENT,
  type SupervisedUser,
  type SupervisedUserLoader,
  type EnforcementTrigger,
  type EvaluateEnforcement,
  type EnforcementSweepOptions,
  type EnforcementSweepResult,
  type EnforcementSweepHandle,
} from "./sweep.js";
