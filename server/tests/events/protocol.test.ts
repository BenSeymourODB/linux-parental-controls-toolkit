/**
 * Unit tests for the event-stream version-compatibility contract (#165,
 * ADR 0007): the pure `negotiate` N-1 window decision and `parseHello`.
 */
import { describe, expect, it } from "vitest";

import { API_VERSION } from "../../src/api/version.js";
import {
  EVENT_PROTOCOL,
  INCOMPATIBLE_PROTOCOL_CODE,
  negotiate,
  parseHello,
  type HelloFrame,
} from "../../src/events/protocol.js";

/** A well-formed hello advertising `eventProtocol`. */
function hello(eventProtocol: number, overrides: Partial<HelloFrame> = {}): HelloFrame {
  return {
    type: "hello",
    agentVersion: "1.2.3",
    eventProtocol,
    capabilities: [],
    ...overrides,
  };
}

describe("negotiate — N-1 window (ADR 0007 §3)", () => {
  // Pin the window math against a fixed server protocol so the test is
  // independent of the current EVENT_PROTOCOL value.
  const P = 5;

  it("accepts a client speaking exactly P, in the current dialect", () => {
    const result = negotiate(hello(P), P);
    expect(result.kind).toBe("accept");
    if (result.kind !== "accept") throw new Error("expected accept");
    expect(result.frame).toEqual({ type: "accept", eventProtocol: P, apiVersion: API_VERSION });
  });

  it("accepts a client speaking P-1, in the N-1 dialect", () => {
    const result = negotiate(hello(P - 1), P);
    expect(result.kind).toBe("accept");
    if (result.kind !== "accept") throw new Error("expected accept");
    // The accept echoes the agreed (older) dialect so the client knows.
    expect(result.frame.eventProtocol).toBe(P - 1);
  });

  it("refuses a client older than P-1 as client_too_old", () => {
    const result = negotiate(hello(P - 2), P);
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toBe("client_too_old");
    expect(result.frame.error.code).toBe(INCOMPATIBLE_PROTOCOL_CODE);
  });

  it("refuses a client newer than P as server_too_old", () => {
    const result = negotiate(hello(P + 1), P);
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toBe("server_too_old");
  });

  it("refuses a null (missing/unparseable) hello as malformed_hello", () => {
    const result = negotiate(null, P);
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toBe("malformed_hello");
    expect(result.frame.error.code).toBe(INCOMPATIBLE_PROTOCOL_CODE);
  });

  it("carries the supplied apiVersion into the accept frame", () => {
    const result = negotiate(hello(P), P, 7);
    if (result.kind !== "accept") throw new Error("expected accept");
    expect(result.frame.apiVersion).toBe(7);
  });

  it("defaults to the server's own EVENT_PROTOCOL / API_VERSION", () => {
    const result = negotiate(hello(EVENT_PROTOCOL));
    expect(result.kind).toBe("accept");
    if (result.kind !== "accept") throw new Error("expected accept");
    expect(result.frame).toEqual({
      type: "accept",
      eventProtocol: EVENT_PROTOCOL,
      apiVersion: API_VERSION,
    });
  });
});

describe("negotiate — configurable compatibility window (#352)", () => {
  const P = 5;

  it("widening the window accepts a client the default window would refuse", () => {
    // P-2 is outside the default N-1 window...
    expect(negotiate(hello(P - 2), P).kind).toBe("refuse");
    // ...but accepted (in its own dialect) with a window of 2.
    const result = negotiate(hello(P - 2), P, undefined, 2);
    expect(result.kind).toBe("accept");
    if (result.kind !== "accept") throw new Error("expected accept");
    expect(result.frame.eventProtocol).toBe(P - 2);
  });

  it("still refuses a client just beyond the widened window as client_too_old", () => {
    const result = negotiate(hello(P - 3), P, undefined, 2);
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toBe("client_too_old");
    // The refusal message reports the widened floor (P - window).
    expect(result.frame.error.message).toContain(`${P - 2}`);
  });

  it("a window below 1 is clamped so a client speaking P is never refused", () => {
    const result = negotiate(hello(P), P, undefined, 0);
    expect(result.kind).toBe("accept");
  });

  it("never accepts a client newer than the server, whatever the window", () => {
    const result = negotiate(hello(P + 1), P, undefined, 5);
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toBe("server_too_old");
  });
});

describe("parseHello", () => {
  it("parses a well-formed hello, defaulting capabilities to []", () => {
    const raw = JSON.stringify({ type: "hello", agentVersion: "2.0.0", eventProtocol: 3 });
    const parsed = parseHello(raw);
    expect(parsed).toEqual({
      type: "hello",
      agentVersion: "2.0.0",
      eventProtocol: 3,
      capabilities: [],
    });
  });

  it("preserves advertised capabilities", () => {
    const raw = JSON.stringify({
      type: "hello",
      agentVersion: "2.0.0",
      eventProtocol: 3,
      capabilities: ["session_budget", "per_app_close"],
    });
    expect(parseHello(raw)?.capabilities).toEqual(["session_budget", "per_app_close"]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseHello("{not json")).toBeNull();
  });

  it("returns null for a non-hello frame type", () => {
    expect(parseHello(JSON.stringify({ type: "accept", eventProtocol: 1 }))).toBeNull();
  });

  it("returns null when required fields are missing or wrong-typed", () => {
    expect(parseHello(JSON.stringify({ type: "hello", eventProtocol: 1 }))).toBeNull();
    expect(
      parseHello(JSON.stringify({ type: "hello", agentVersion: "1", eventProtocol: -1 })),
    ).toBeNull();
    expect(
      parseHello(JSON.stringify({ type: "hello", agentVersion: "", eventProtocol: 1 })),
    ).toBeNull();
  });
});
