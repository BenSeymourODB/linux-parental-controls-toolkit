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
 * store. This module *decides* — emitting `enforce.force_close` after grace and
 * the SSH `pkill` fallback is #99, over the #100 event channel.
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
