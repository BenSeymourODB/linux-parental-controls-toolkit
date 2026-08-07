/**
 * Unit tests for the fan-out hub (#100). Connections are plain fakes behind
 * the {@link EventSocket} interface, so these cover the registry + publish
 * logic without a real WebSocket: per-client isolation, multi-connection
 * delivery, skipping non-open sockets, broadcast, liveness/counts, the stamped
 * frame, and capability-based frame gating (#288, ADR 0007 §4).
 */
import { describe, expect, it } from "vitest";

import { CLIENT_CAPABILITIES } from "../../src/events/capabilities.js";
import { EventHub, SOCKET_OPEN, type EventSocket } from "../../src/events/hub.js";
import type { ServerEvent } from "../../src/events/taxonomy.js";

/** A capturing fake socket. `readyState` defaults to OPEN. */
class FakeSocket implements EventSocket {
  readyState = SOCKET_OPEN;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

/** `lockout.cleared` is gated on `session_budget`; fakes advertise it to receive it. */
const SESSION_BUDGET = [CLIENT_CAPABILITIES.sessionBudget];
const PER_APP_CLOSE = [CLIENT_CAPABILITIES.perAppClose];

const lockoutCleared = (userId: number): ServerEvent => ({ type: "lockout.cleared", userId });
const policyChanged = (userId: number): ServerEvent => ({ type: "policy.changed", userId });
const forceClose = (userId: number, activityId: number): ServerEvent => ({
  type: "enforce.force_close",
  userId,
  activityId,
});
const sessionLock = (userId: number): ServerEvent => ({ type: "enforce.session_lock", userId });

describe("EventHub — fan-out", () => {
  it("delivers a published event only to the targeted client's connections", () => {
    const hub = new EventHub();
    const a1 = new FakeSocket();
    const a2 = new FakeSocket();
    const b1 = new FakeSocket();
    hub.register(1, a1, SESSION_BUDGET);
    hub.register(1, a2, SESSION_BUDGET);
    hub.register(2, b1, SESSION_BUDGET);

    const delivered = hub.publishToClient(1, lockoutCleared(1));

    expect(delivered).toBe(2);
    expect(a1.sent).toHaveLength(1);
    expect(a2.sent).toHaveLength(1);
    expect(b1.sent).toHaveLength(0);
  });

  it("returns 0 when the client has no connection", () => {
    const hub = new EventHub();
    expect(hub.publishToClient(99, lockoutCleared(1))).toBe(0);
  });

  it("skips a connection that is not OPEN", () => {
    const hub = new EventHub();
    const open = new FakeSocket();
    const closing = new FakeSocket();
    closing.readyState = 2; // CLOSING
    hub.register(1, open, SESSION_BUDGET);
    hub.register(1, closing, SESSION_BUDGET);

    expect(hub.publishToClient(1, lockoutCleared(1))).toBe(1);
    expect(open.sent).toHaveLength(1);
    expect(closing.sent).toHaveLength(0);
  });

  it("broadcasts to every client's open connections", () => {
    const hub = new EventHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.register(1, a, SESSION_BUDGET);
    hub.register(2, b, SESSION_BUDGET);

    expect(hub.broadcast(lockoutCleared(1))).toBe(2);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });
});

describe("EventHub — capability gating (ADR 0007 §4)", () => {
  it("delivers a baseline (ungated) frame to a connection that advertised nothing", () => {
    const hub = new EventHub();
    const socket = new FakeSocket();
    hub.register(1, socket); // no capabilities

    expect(hub.publishToClient(1, policyChanged(1))).toBe(1);
    expect(socket.sent).toHaveLength(1);
  });

  it("withholds a gated frame from a connection lacking the capability", () => {
    const hub = new EventHub();
    const socket = new FakeSocket();
    hub.register(1, socket); // advertises nothing

    // Gated on per_app_close / session_budget respectively — neither advertised.
    expect(hub.publishToClient(1, forceClose(1, 7))).toBe(0);
    expect(hub.publishToClient(1, sessionLock(1))).toBe(0);
    expect(socket.sent).toHaveLength(0);
    // ...but the connection is still live: gating withholds, never disconnects.
    expect(hub.isClientLive(1)).toBe(true);
  });

  it("delivers a gated frame to a connection that advertised the capability", () => {
    const hub = new EventHub();
    const socket = new FakeSocket();
    hub.register(1, socket, PER_APP_CLOSE);

    expect(hub.publishToClient(1, forceClose(1, 7))).toBe(1);
    expect(socket.sent).toHaveLength(1);
  });

  it("does not let one capability authorise a frame gated on another", () => {
    const hub = new EventHub();
    const socket = new FakeSocket();
    hub.register(1, socket, PER_APP_CLOSE); // has per_app_close, not session_budget

    expect(hub.publishToClient(1, forceClose(1, 7))).toBe(1); // per_app_close ✓
    expect(hub.publishToClient(1, sessionLock(1))).toBe(0); // needs session_budget ✗
    expect(socket.sent).toHaveLength(1);
  });

  it("filters a gated frame per-connection within one client", () => {
    const hub = new EventHub();
    const capable = new FakeSocket();
    const incapable = new FakeSocket();
    hub.register(1, capable, PER_APP_CLOSE);
    hub.register(1, incapable, SESSION_BUDGET);

    const delivered = hub.publishToClient(1, forceClose(1, 7));

    expect(delivered).toBe(1);
    expect(capable.sent).toHaveLength(1);
    expect(incapable.sent).toHaveLength(0);
  });

  it("gates broadcasts the same way across clients", () => {
    const hub = new EventHub();
    const capable = new FakeSocket();
    const incapable = new FakeSocket();
    hub.register(1, capable, SESSION_BUDGET);
    hub.register(2, incapable); // advertises nothing

    const delivered = hub.broadcast(sessionLock(1));

    expect(delivered).toBe(1);
    expect(capable.sent).toHaveLength(1);
    expect(incapable.sent).toHaveLength(0);
  });

  it("re-registering the same socket refreshes its capability set", () => {
    const hub = new EventHub();
    const socket = new FakeSocket();
    hub.register(1, socket); // nothing → withheld
    expect(hub.publishToClient(1, forceClose(1, 7))).toBe(0);

    hub.register(1, socket, PER_APP_CLOSE); // now capable
    expect(hub.publishToClient(1, forceClose(1, 7))).toBe(1);
    expect(hub.connectionCount).toBe(1); // still one connection, not two
  });
});

describe("EventHub — lifecycle + liveness", () => {
  it("tracks live clients and connection counts; prunes on last unregister", () => {
    const hub = new EventHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    expect(hub.connectionCount).toBe(0);
    expect(hub.isClientLive(1)).toBe(false);

    hub.register(1, s1);
    hub.register(1, s2);
    expect(hub.connectionCount).toBe(2);
    expect(hub.isClientLive(1)).toBe(true);
    expect(hub.liveClientIds()).toEqual([1]);

    hub.unregister(1, s1);
    expect(hub.isClientLive(1)).toBe(true); // s2 still open
    hub.unregister(1, s2);
    expect(hub.isClientLive(1)).toBe(false);
    expect(hub.connectionCount).toBe(0);
    expect(hub.liveClientIds()).toEqual([]);
  });

  it("unregister is a no-op for an unknown client or socket", () => {
    const hub = new EventHub();
    const known = new FakeSocket();
    hub.register(1, known);
    hub.unregister(2, new FakeSocket()); // unknown client
    hub.unregister(1, new FakeSocket()); // unknown socket on a known client
    expect(hub.isClientLive(1)).toBe(true);
    expect(hub.connectionCount).toBe(1);
  });
});

describe("EventHub — frame stamping", () => {
  it("wraps the event in a frame with a monotonic seq and an ISO timestamp", () => {
    const hub = new EventHub();
    const socket = new FakeSocket();
    hub.register(1, socket, SESSION_BUDGET);

    hub.publishToClient(1, lockoutCleared(1));
    hub.publishToClient(1, policyChanged(1));

    const [firstRaw, secondRaw] = socket.sent;
    if (firstRaw === undefined || secondRaw === undefined) {
      throw new Error("expected two frames to have been sent");
    }
    const first = JSON.parse(firstRaw) as { seq: number; at: string; event: ServerEvent };
    const second = JSON.parse(secondRaw) as { seq: number; at: string; event: ServerEvent };

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.event.type).toBe("lockout.cleared");
    expect(second.event.type).toBe("policy.changed");
    expect(Number.isNaN(Date.parse(first.at))).toBe(false);
  });
});
