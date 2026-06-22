/**
 * Unit tests for the event taxonomy (#100): each event schema accepts its
 * valid shape and rejects malformed input, the discriminated union routes on
 * `type` and rejects unknown types, and the wire-frame envelope validates.
 */
import { describe, expect, it } from "vitest";

import {
  enforceForceCloseSchema,
  enforceSessionLockSchema,
  eventFrameSchema,
  grantAppliedSchema,
  lockoutClearedSchema,
  policyChangedSchema,
  serverEventSchema,
} from "../../src/events/taxonomy.js";

describe("event taxonomy — grant.applied", () => {
  it("accepts an overall grant (activityId null)", () => {
    const parsed = grantAppliedSchema.parse({
      type: "grant.applied",
      userId: 7,
      grantedSeconds: 1800,
      reason: "chores done",
      activityId: null,
    });
    expect(parsed.activityId).toBeNull();
    expect(parsed.grantedSeconds).toBe(1800);
  });

  it("accepts a per-activity grant", () => {
    const parsed = grantAppliedSchema.parse({
      type: "grant.applied",
      userId: 7,
      grantedSeconds: 2700,
      reason: "extra YouTube",
      activityId: 3,
    });
    expect(parsed.activityId).toBe(3);
  });

  it("rejects a non-positive grant, a missing reason, and a non-integer user", () => {
    expect(
      grantAppliedSchema.safeParse({
        type: "grant.applied",
        userId: 7,
        grantedSeconds: 0,
        reason: "x",
        activityId: null,
      }).success,
    ).toBe(false);
    expect(
      grantAppliedSchema.safeParse({
        type: "grant.applied",
        userId: 7,
        grantedSeconds: 60,
        reason: "",
        activityId: null,
      }).success,
    ).toBe(false);
    expect(
      grantAppliedSchema.safeParse({
        type: "grant.applied",
        userId: 1.5,
        grantedSeconds: 60,
        reason: "x",
        activityId: null,
      }).success,
    ).toBe(false);
  });
});

describe("event taxonomy — policy.changed", () => {
  it("accepts with and without an optional summary", () => {
    expect(
      policyChangedSchema.parse({ type: "policy.changed", userId: 1 }).summary,
    ).toBeUndefined();
    expect(
      policyChangedSchema.parse({ type: "policy.changed", userId: 1, summary: "now 1h" }).summary,
    ).toBe("now 1h");
  });

  it("rejects an empty summary", () => {
    expect(
      policyChangedSchema.safeParse({ type: "policy.changed", userId: 1, summary: "" }).success,
    ).toBe(false);
  });
});

describe("event taxonomy — enforce + lockout", () => {
  it("force_close carries a target activityId", () => {
    const parsed = enforceForceCloseSchema.parse({
      type: "enforce.force_close",
      userId: 2,
      activityId: 9,
    });
    expect(parsed.activityId).toBe(9);
    expect(
      enforceForceCloseSchema.safeParse({ type: "enforce.force_close", userId: 2 }).success,
    ).toBe(false);
  });

  it("session_lock and lockout.cleared carry just a userId", () => {
    expect(enforceSessionLockSchema.parse({ type: "enforce.session_lock", userId: 4 }).userId).toBe(
      4,
    );
    expect(lockoutClearedSchema.parse({ type: "lockout.cleared", userId: 5 }).userId).toBe(5);
  });
});

describe("event taxonomy — discriminated union", () => {
  it("routes each valid event by its type", () => {
    for (const event of [
      { type: "grant.applied", userId: 1, grantedSeconds: 60, reason: "r", activityId: null },
      { type: "policy.changed", userId: 1 },
      { type: "enforce.force_close", userId: 1, activityId: 2 },
      { type: "enforce.session_lock", userId: 1 },
      { type: "lockout.cleared", userId: 1 },
    ]) {
      expect(serverEventSchema.parse(event).type).toBe(event.type);
    }
  });

  it("rejects an unknown event type", () => {
    expect(serverEventSchema.safeParse({ type: "enforce.reboot", userId: 1 }).success).toBe(false);
  });
});

describe("event taxonomy — frame envelope", () => {
  it("accepts a well-formed frame", () => {
    const frame = eventFrameSchema.parse({
      seq: 0,
      at: "2026-06-19T12:00:00.000Z",
      event: { type: "lockout.cleared", userId: 1 },
    });
    expect(frame.seq).toBe(0);
    expect(frame.event.type).toBe("lockout.cleared");
  });

  it("rejects a negative seq, a bad timestamp, and a bad nested event", () => {
    const base = {
      seq: 1,
      at: "2026-06-19T12:00:00.000Z",
      event: { type: "lockout.cleared", userId: 1 },
    };
    expect(eventFrameSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(eventFrameSchema.safeParse({ ...base, at: "not-a-date" }).success).toBe(false);
    expect(eventFrameSchema.safeParse({ ...base, event: { type: "nope" } }).success).toBe(false);
  });
});
