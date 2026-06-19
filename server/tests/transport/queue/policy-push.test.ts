/**
 * Unit tests for the PolicyPushCommand → queued-action adapter (#84): the
 * coalesce-key derivation that collapses repeated edits to the same target.
 */
import { describe, expect, it } from "vitest";

import {
  POLICY_PUSH_KIND,
  queuedActionFromPolicyPush,
} from "../../../src/transport/queue/policy-push.js";
import type { PolicyPushCommand } from "../../../src/transport/stub.js";

describe("queuedActionFromPolicyPush", () => {
  it("derives a user-scoped coalesce key from a user-level change", () => {
    const command: PolicyPushCommand = {
      clientId: 7,
      userId: 3,
      reason: "user.updated",
      detail: { displayName: "Alice" },
    };
    expect(queuedActionFromPolicyPush(command)).toEqual({
      clientId: 7,
      coalesceKey: "user:3",
      kind: POLICY_PUSH_KIND,
      payload: { userId: 3, reason: "user.updated", detail: { displayName: "Alice" } },
    });
  });

  it("derives the client-scoped coalesce key when there is no user", () => {
    const command: PolicyPushCommand = {
      clientId: 7,
      userId: null,
      reason: "client.updated",
      detail: { hostname: "mint-09" },
    };
    const queued = queuedActionFromPolicyPush(command);
    expect(queued.coalesceKey).toBe("client");
    expect(queued.payload).toEqual({
      userId: null,
      reason: "client.updated",
      detail: { hostname: "mint-09" },
    });
  });

  it("gives distinct users distinct coalesce keys on the same client", () => {
    const base = { clientId: 1, reason: "user.updated", detail: {} } as const;
    const a = queuedActionFromPolicyPush({ ...base, userId: 1 });
    const b = queuedActionFromPolicyPush({ ...base, userId: 2 });
    expect(a.coalesceKey).not.toBe(b.coalesceKey);
  });
});
