/**
 * Live policy-push transport (#201, Phase 4): the swap from the Phase-2 logging
 * stub (`../stub.ts`) to a real `timekpra`-over-SSH dispatch.
 *
 * Layering: {@link ./resolve.js} (pure policy → `timekpra` inputs) ←
 * {@link ./executor.js} (the offline-queue {@link import("../queue/types.js").ActionExecutor},
 * shared by the online push and the replay loop) ← {@link ./dispatcher.js} (the
 * {@link import("../stub.js").PolicyPushStub} the CRUD routes call, over
 * `pushOrEnqueue`). {@link ./bootstrap.js} assembles them with the SSH facade,
 * the audit log (#85), and the drainer (#84) — or the logging fallback when no
 * SSH key exists yet (#39). {@link ./payload.js} validates a replayed queue row.
 */
export const moduleName = "transport/policy-push";

export { policyPushPayloadSchema, type ValidatedPolicyPushPayload } from "./payload.js";
export {
  resolvePolicyPush,
  unrestrictedPolicyPush,
  type PolicyPushResolveInput,
  type ResolvedPolicyPush,
} from "./resolve.js";
export {
  createPolicyPushExecutor,
  type PolicyPushClient,
  type PolicyPushClientFactory,
  type PolicyPushClientTarget,
  type PolicyPushExecutorLogger,
  type PolicyPushExecutorOptions,
} from "./executor.js";
export {
  createPolicyPushDispatcher,
  POLICY_PUSH_COMPONENT,
  type PolicyPushDispatcherOptions,
} from "./dispatcher.js";
export {
  createPolicyPushTransport,
  type BootstrapSshTransport,
  type CreatePolicyPushTransportOptions,
  type PolicyPushTransport,
} from "./bootstrap.js";
