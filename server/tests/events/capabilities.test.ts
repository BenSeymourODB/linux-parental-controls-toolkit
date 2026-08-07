/**
 * Unit tests for the frame → capability gate (#288, ADR 0007 §4). Pure and
 * I/O-free: assert the capability vocabulary matches the ADR's wire strings and
 * that every event type maps to the intended gate (or to `null` for a baseline
 * frame every client receives).
 */
import { describe, expect, it } from "vitest";

import { CLIENT_CAPABILITIES, capabilityForEvent } from "../../src/events/capabilities.js";
import type { ServerEvent } from "../../src/events/taxonomy.js";

describe("CLIENT_CAPABILITIES", () => {
  it("uses the ADR 0007 §4 wire strings", () => {
    // These strings cross the wire in the client `hello`; they must not drift.
    expect(CLIENT_CAPABILITIES.perAppClose).toBe("per_app_close");
    expect(CLIENT_CAPABILITIES.sessionBudget).toBe("session_budget");
  });
});

describe("capabilityForEvent", () => {
  it("gates enforce.force_close on per_app_close", () => {
    const event: ServerEvent = { type: "enforce.force_close", userId: 1, activityId: 7 };
    expect(capabilityForEvent(event)).toBe("per_app_close");
  });

  it("gates enforce.session_lock on session_budget", () => {
    const event: ServerEvent = { type: "enforce.session_lock", userId: 1 };
    expect(capabilityForEvent(event)).toBe("session_budget");
  });

  it("gates lockout.cleared on session_budget", () => {
    const event: ServerEvent = { type: "lockout.cleared", userId: 1 };
    expect(capabilityForEvent(event)).toBe("session_budget");
  });

  it("leaves grant.applied ungated (baseline frame)", () => {
    const event: ServerEvent = {
      type: "grant.applied",
      userId: 1,
      grantedSeconds: 1800,
      reason: "chores done",
      activityId: null,
    };
    expect(capabilityForEvent(event)).toBeNull();
  });

  it("leaves policy.changed ungated (baseline frame)", () => {
    const event: ServerEvent = { type: "policy.changed", userId: 1 };
    expect(capabilityForEvent(event)).toBeNull();
  });
});
