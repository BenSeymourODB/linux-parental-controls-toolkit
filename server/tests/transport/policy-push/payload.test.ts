/**
 * Unit tests for the replayed `policy.push` payload validation (#201): the
 * guard that a persisted/hand-edited queue row is well-formed before the live
 * push acts on it.
 */
import { describe, expect, it } from "vitest";

import { policyPushPayloadSchema } from "../../../src/transport/policy-push/payload.js";

describe("policyPushPayloadSchema", () => {
  it("accepts a user-scoped payload", () => {
    const parsed = policyPushPayloadSchema.parse({
      userId: 3,
      reason: "budget.updated",
      detail: { secondsAllowed: 7200 },
    });
    expect(parsed).toEqual({
      userId: 3,
      reason: "budget.updated",
      detail: { secondsAllowed: 7200 },
    });
  });

  it("accepts a client-scoped payload with a null user", () => {
    const parsed = policyPushPayloadSchema.parse({
      userId: null,
      reason: "client.updated",
      detail: {},
    });
    expect(parsed.userId).toBeNull();
  });

  it("rejects a payload missing the reason", () => {
    expect(() => policyPushPayloadSchema.parse({ userId: 1, detail: {} })).toThrow();
  });

  it("rejects a non-integer userId", () => {
    expect(() =>
      policyPushPayloadSchema.parse({ userId: 1.5, reason: "user.updated", detail: {} }),
    ).toThrow();
  });
});
