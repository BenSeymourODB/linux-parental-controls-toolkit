/** Transport facade: subprocess + REST runners reaching each client component. */
export const moduleName = "transport";

// Phase-2 stub transport (#54): logs the intended per-client effect of a
// policy change instead of dispatching it — the seam Phase 4 (SSH + timekpra)
// and Phase 6 (Ansible) fill in.
export {
  PUSH_STUB_COMPONENT,
  PUSH_STUB_MESSAGE,
  createPolicyPushStub,
  userPushCommands,
  clientPushCommands,
  linkPushCommands,
  type PolicyPushStub,
  type PolicyPushCommand,
  type PolicyPushReason,
  type UserPushReason,
  type ClientPushReason,
  type LinkPushReason,
} from "./stub.js";
