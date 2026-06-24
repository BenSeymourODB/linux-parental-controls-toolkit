import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  eventFrameSchema,
  FrameDecodeError,
  serverEventSchema,
  type ServerEventType,
} from "../../src/bridge/protocol.js";

/** A well-formed frame for a given event, with sensible envelope defaults. */
function frame(event: unknown, seq = 1, at = "2026-06-24T02:00:00.000Z"): string {
  return JSON.stringify({ seq, at, event });
}

describe("protocol — event taxonomy fidelity", () => {
  it("accepts all five server event types (the on-main taxonomy)", () => {
    const events: { type: ServerEventType; event: Record<string, unknown> }[] = [
      {
        type: "grant.applied",
        event: {
          type: "grant.applied",
          userId: 7,
          grantedSeconds: 1800,
          reason: "chores done",
          activityId: null,
        },
      },
      { type: "policy.changed", event: { type: "policy.changed", userId: 7, summary: "1h now" } },
      {
        type: "enforce.force_close",
        event: { type: "enforce.force_close", userId: 7, activityId: 42 },
      },
      { type: "enforce.session_lock", event: { type: "enforce.session_lock", userId: 7 } },
      { type: "lockout.cleared", event: { type: "lockout.cleared", userId: 7 } },
    ];
    for (const { type, event } of events) {
      const decoded = decodeFrame(frame(event));
      expect(decoded.event.type).toBe(type);
      expect(decoded.event.userId).toBe(7);
    }
  });

  it("treats grant.applied activityId as nullable and policy summary as optional", () => {
    const withActivity = decodeFrame(
      frame({ type: "grant.applied", userId: 1, grantedSeconds: 60, reason: "x", activityId: 9 }),
    );
    expect(withActivity.event).toMatchObject({ type: "grant.applied", activityId: 9 });

    const noSummary = decodeFrame(frame({ type: "policy.changed", userId: 1 }));
    expect(noSummary.event).toMatchObject({ type: "policy.changed" });
  });

  it("rejects an unknown event type", () => {
    expect(() => decodeFrame(frame({ type: "bogus.event", userId: 1 }))).toThrow(FrameDecodeError);
  });
});

describe("protocol — frame envelope", () => {
  it("requires seq (non-negative int), at (ISO-8601 UTC), and event", () => {
    expect(eventFrameSchema.safeParse({ seq: 0, at: "2026-06-24T02:00:00.000Z" }).success).toBe(
      false,
    );
    expect(
      eventFrameSchema.safeParse({
        seq: -1,
        at: "2026-06-24T02:00:00.000Z",
        event: { type: "lockout.cleared", userId: 1 },
      }).success,
    ).toBe(false);
    expect(
      eventFrameSchema.safeParse({
        seq: 3,
        at: "not-a-date",
        event: { type: "lockout.cleared", userId: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive userId", () => {
    expect(serverEventSchema.safeParse({ type: "lockout.cleared", userId: 0 }).success).toBe(false);
  });
});

describe("decodeFrame", () => {
  it("decodes a UTF-8 binary (Buffer) message the same as a string", () => {
    const text = frame({ type: "enforce.session_lock", userId: 5 });
    const fromString = decodeFrame(text);
    const fromBuffer = decodeFrame(Buffer.from(text, "utf8"));
    expect(fromBuffer).toEqual(fromString);
  });

  it("throws FrameDecodeError carrying the cause on malformed JSON", () => {
    try {
      decodeFrame("{not json");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FrameDecodeError);
      expect((err as FrameDecodeError).message).toMatch(/not valid JSON/);
      expect((err as FrameDecodeError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("throws FrameDecodeError on a schema-invalid frame", () => {
    expect(() => decodeFrame(JSON.stringify({ seq: 1, at: "2026-06-24T02:00:00.000Z" }))).toThrow(
      /schema validation/,
    );
  });
});
