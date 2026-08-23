import { describe, expect, it } from "vitest";

import {
  acceptFrameSchema,
  BRIDGE_CAPABILITIES,
  buildHello,
  EVENT_PROTOCOL,
  helloFrameSchema,
  INCOMPATIBLE_PROTOCOL_CODE,
  parseHandshakeReply,
  refuseFrameSchema,
} from "../../src/bridge/handshake.js";

describe("handshake — the client hello", () => {
  it("builds a schema-valid hello advertising the protocol and both capabilities", () => {
    const hello = buildHello({ agentVersion: "1.2.3" });
    expect(helloFrameSchema.safeParse(hello).success).toBe(true);
    expect(hello).toEqual({
      type: "hello",
      agentVersion: "1.2.3",
      eventProtocol: EVENT_PROTOCOL,
      capabilities: ["session_budget", "per_app_close"],
    });
  });

  it("advertises the Linux enforcement primitives the server gates on", () => {
    // Mirror of server/src/events/capabilities.ts CLIENT_CAPABILITIES: the bridge
    // forwards all five events, so it advertises both gated primitives.
    expect(BRIDGE_CAPABILITIES).toEqual(["session_budget", "per_app_close"]);
  });

  it("copies the capabilities array (no shared mutable reference to the constant)", () => {
    const hello = buildHello({ agentVersion: "1.0.0" });
    expect(hello.capabilities).not.toBe(BRIDGE_CAPABILITIES);
    hello.capabilities.push("mutated");
    expect(BRIDGE_CAPABILITIES).toEqual(["session_budget", "per_app_close"]);
  });

  it("honours explicit protocol and capability overrides", () => {
    const hello = buildHello({
      agentVersion: "9.9.9",
      eventProtocol: 2,
      capabilities: ["session_budget"],
    });
    expect(hello.eventProtocol).toBe(2);
    expect(hello.capabilities).toEqual(["session_budget"]);
  });
});

describe("handshake — parsing the server reply", () => {
  it("parses an accept frame", () => {
    const reply = parseHandshakeReply(
      JSON.stringify({ type: "accept", eventProtocol: 1, apiVersion: 3 }),
    );
    expect(reply).toEqual({
      kind: "accept",
      frame: { type: "accept", eventProtocol: 1, apiVersion: 3 },
    });
  });

  it("parses a refuse frame carrying the incompatible-protocol code", () => {
    const reply = parseHandshakeReply(
      JSON.stringify({
        type: "refuse",
        error: { code: INCOMPATIBLE_PROTOCOL_CODE, message: "update the client" },
      }),
    );
    expect(reply?.kind).toBe("refuse");
    if (reply?.kind === "refuse") {
      expect(reply.frame.error.code).toBe("incompatible_protocol");
      expect(reply.frame.error.message).toBe("update the client");
    }
  });

  it("decodes a Buffer reply identically to a string", () => {
    const raw = Buffer.from(JSON.stringify({ type: "accept", eventProtocol: 1, apiVersion: 1 }));
    expect(parseHandshakeReply(raw)?.kind).toBe("accept");
  });

  it("returns null for malformed JSON", () => {
    expect(parseHandshakeReply("{not json")).toBeNull();
  });

  it("returns null for an event frame arriving where a reply was expected", () => {
    // The server always sends accept/refuse first; an event frame here is a
    // protocol violation the caller must not mistake for a handshake reply.
    const eventFrame = JSON.stringify({
      seq: 1,
      at: "2026-06-24T02:00:00.000Z",
      event: { type: "policy.changed", userId: 7 },
    });
    expect(parseHandshakeReply(eventFrame)).toBeNull();
  });

  it("returns null for a refuse frame with an unknown error code", () => {
    const reply = parseHandshakeReply(
      JSON.stringify({ type: "refuse", error: { code: "something_else", message: "x" } }),
    );
    expect(reply).toBeNull();
  });

  it("returns null for an accept frame missing apiVersion", () => {
    expect(parseHandshakeReply(JSON.stringify({ type: "accept", eventProtocol: 1 }))).toBeNull();
  });
});

describe("handshake — client schema pinned to the server-contract copy", () => {
  // The bridge cannot import server/src, so these payloads are copied verbatim
  // from server/src/events/protocol.ts to pin the *client's* schema shapes to
  // that contract. This cannot detect a server-side rename by itself (nothing
  // here imports the server schema); it fixes the client copy so a hand-edit
  // that diverges from the copied samples fails — the same limitation and intent
  // as tests/bridge/protocol.test.ts for the event envelope.
  it("the hello shape matches the server's helloFrameSchema fields", () => {
    const serverShapedHello = {
      type: "hello",
      agentVersion: "0.0.0",
      eventProtocol: 1,
      capabilities: ["session_budget", "per_app_close"],
    };
    expect(helloFrameSchema.safeParse(serverShapedHello).success).toBe(true);
  });

  it("rejects a hello with a non-positive eventProtocol", () => {
    expect(
      helloFrameSchema.safeParse({
        type: "hello",
        agentVersion: "1",
        eventProtocol: 0,
        capabilities: [],
      }).success,
    ).toBe(false);
  });

  it("the accept/refuse shapes match the server's frame schemas", () => {
    expect(
      acceptFrameSchema.safeParse({ type: "accept", eventProtocol: 1, apiVersion: 1 }).success,
    ).toBe(true);
    expect(
      refuseFrameSchema.safeParse({
        type: "refuse",
        error: { code: "incompatible_protocol", message: "m" },
      }).success,
    ).toBe(true);
  });
});
