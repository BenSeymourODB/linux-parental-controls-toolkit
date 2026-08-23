import { describe, expect, it, vi } from "vitest";

import { buildHello, type AcceptFrame, type RefuseFrame } from "../../src/bridge/handshake.js";
import type { Logger } from "../../src/bridge/logger.js";
import type { EventFrame } from "../../src/bridge/protocol.js";
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  WsClient,
  type Timers,
  type WebSocketFactory,
  type WebSocketLike,
} from "../../src/bridge/ws-client.js";

type RawMessage = string | Buffer | ArrayBuffer | Buffer[];

/** A controllable fake socket that records listeners + sends and exposes emitters. */
class FakeSocket implements WebSocketLike {
  #open?: () => void;
  #message?: (data: RawMessage) => void;
  #close?: () => void;
  #error?: (err: Error) => void;
  readonly sent: string[] = [];
  closed = false;
  terminated = false;

  on(event: "open" | "close", listener: () => void): this;
  on(event: "message", listener: (data: RawMessage) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "open" | "message" | "close" | "error",
    listener: (() => void) | ((data: RawMessage) => void) | ((err: Error) => void),
  ): this {
    switch (event) {
      case "open":
        this.#open = listener as () => void;
        break;
      case "message":
        this.#message = listener as (data: RawMessage) => void;
        break;
      case "close":
        this.#close = listener as () => void;
        break;
      case "error":
        this.#error = listener as (err: Error) => void;
        break;
    }
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  terminate(): void {
    this.terminated = true;
  }

  emitOpen(): void {
    this.#open?.();
  }
  emitMessage(data: RawMessage): void {
    this.#message?.(data);
  }
  emitClose(): void {
    this.#close?.();
  }
  emitError(err: Error): void {
    this.#error?.(err);
  }
}

/** A timer source the test fires by hand. */
class FakeTimers implements Timers {
  readonly scheduled: { handler: () => void; ms: number; cleared: boolean; unref: () => void }[] =
    [];
  set(handler: () => void, ms: number): { unref?: () => void } {
    const h = { handler, ms, cleared: false, unref: (): undefined => undefined };
    this.scheduled.push(h);
    return h;
  }
  clear(handle: { unref?: () => void }): void {
    const found = this.scheduled.find((s) => s === handle);
    if (found) found.cleared = true;
  }
  /** Fire the most recently scheduled (uncleared) timer. */
  fireLast(): void {
    const last = this.scheduled.at(-1);
    if (last && !last.cleared) last.handler();
  }
  /** The delays of the reconnect timers (excluding the handshake timeout). */
  reconnectDelays(): number[] {
    return this.scheduled.filter((s) => s.ms !== DEFAULT_HANDSHAKE_TIMEOUT_MS).map((s) => s.ms);
  }
}

const noopLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup(overrides: Partial<Parameters<typeof makeClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const headers: Record<string, string>[] = [];
  const factory: WebSocketFactory = (_url, options) => {
    headers.push(options.headers);
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const timers = new FakeTimers();
  const frames: EventFrame[] = [];
  const client = makeClient({
    onFrame: (f) => frames.push(f),
    factory,
    timers,
    rng: () => 0.999999,
    ...overrides,
  });
  return { client, sockets, headers, timers, frames };
}

function makeClient(opts: {
  onFrame: (f: EventFrame) => void;
  factory: WebSocketFactory;
  timers: Timers;
  rng: () => number;
  logger?: Logger;
  onAccept?: (f: AcceptFrame) => void;
  onRefuse?: (f: RefuseFrame) => void;
}): WsClient {
  return new WsClient({
    url: "wss://dash.example/api/events/stream",
    token: "tok_abc",
    agentVersion: "1.0.0",
    onFrame: opts.onFrame,
    backoff: { baseMs: 1_000, maxMs: 60_000 },
    logger: opts.logger ?? noopLogger,
    factory: opts.factory,
    timers: opts.timers,
    rng: opts.rng,
    ...(opts.onAccept ? { onAccept: opts.onAccept } : {}),
    ...(opts.onRefuse ? { onRefuse: opts.onRefuse } : {}),
  });
}

const acceptFrame = JSON.stringify({ type: "accept", eventProtocol: 1, apiVersion: 1 });
const refuseFrame = JSON.stringify({
  type: "refuse",
  error: { code: "incompatible_protocol", message: "update the client" },
});

const sampleFrame = (seq = 1): EventFrame => ({
  seq,
  at: "2026-06-24T02:00:00.000Z",
  event: { type: "policy.changed", userId: 7, summary: "1h now" },
});

/** Drive a socket through open → hello → accept so it is in the streaming state. */
function completeHandshake(socket: FakeSocket): void {
  socket.emitOpen();
  socket.emitMessage(acceptFrame);
}

describe("WsClient", () => {
  it("connects with the Authorization: Bearer header", () => {
    const { client, headers } = setup();
    client.start();
    expect(headers).toHaveLength(1);
    expect(headers[0]).toEqual({ Authorization: "Bearer tok_abc" });
  });

  it("speaks first: sends a hello advertising version + capabilities on open", () => {
    const { client, sockets } = setup();
    client.start();
    sockets[0]?.emitOpen();
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(JSON.parse(sockets[0]?.sent[0] ?? "null")).toEqual(
      buildHello({ agentVersion: "1.0.0" }),
    );
  });

  it("does not forward event frames before the handshake is accepted", () => {
    const warn = vi.fn();
    const { client, sockets, frames } = setup({ logger: { ...noopLogger, warn } });
    client.start();
    sockets[0]?.emitOpen();
    // An event frame arriving before accept is a protocol violation: dropped, and
    // the socket is closed to retry rather than forwarded.
    sockets[0]?.emitMessage(JSON.stringify(sampleFrame(9)));
    expect(frames).toEqual([]);
    expect(sockets[0]?.closed).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      "unexpected pre-handshake frame; closing to retry",
    );
  });

  it("forwards event frames once the handshake is accepted", () => {
    const onAccept = vi.fn();
    const { client, sockets, frames } = setup({ onAccept });
    client.start();
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage(acceptFrame);
    expect(onAccept).toHaveBeenCalledTimes(1);
    sockets[0]?.emitMessage(JSON.stringify(sampleFrame(9)));
    expect(frames).toEqual([sampleFrame(9)]);
  });

  it("decodes a Buffer event message the same as a string (post-accept)", () => {
    const { client, sockets, frames } = setup();
    client.start();
    completeHandshake(sockets[0] as FakeSocket);
    sockets[0]?.emitMessage(Buffer.from(JSON.stringify(sampleFrame(3)), "utf8"));
    expect(frames).toEqual([sampleFrame(3)]);
  });

  it("drops a malformed event frame without throwing or forwarding (post-accept)", () => {
    const warn = vi.fn();
    const { client, sockets, frames } = setup({ logger: { ...noopLogger, warn } });
    client.start();
    completeHandshake(sockets[0] as FakeSocket);
    expect(() => sockets[0]?.emitMessage("{not json")).not.toThrow();
    expect(frames).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.anything(), "dropping undecodable frame");
  });

  it("on refuse: surfaces update_required and does NOT reconnect", () => {
    const error = vi.fn();
    const onRefuse = vi.fn();
    const { client, sockets, timers } = setup({ logger: { ...noopLogger, error }, onRefuse });
    client.start();
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage(refuseFrame);

    expect(onRefuse).toHaveBeenCalledWith({
      type: "refuse",
      error: { code: "incompatible_protocol", message: "update the client" },
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: "incompatible_protocol" }),
      expect.stringContaining("not reconnecting"),
    );
    expect(sockets[0]?.terminated).toBe(true);

    // Even the server-driven close after a refuse must not schedule a reconnect.
    sockets[0]?.emitClose();
    expect(timers.reconnectDelays()).toEqual([]);
    // A stale reconnect attempt would create a second socket; none should exist.
    expect(sockets).toHaveLength(1);
  });

  it("re-enables reconnect after start() following a refuse", () => {
    const { client, sockets } = setup();
    client.start();
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage(refuseFrame); // refused, no reconnect
    client.start(); // operator/unit restart clears the refusal
    expect(sockets).toHaveLength(2);
  });

  it("closes and reconnects if no handshake reply arrives before the timeout", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitOpen();
    // The last scheduled timer is the handshake timeout; firing it closes the socket.
    const handshakeTimer = timers.scheduled.at(-1);
    expect(handshakeTimer?.ms).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer?.handler();
    expect(sockets[0]?.closed).toBe(true);

    sockets[0]?.emitClose();
    expect(timers.reconnectDelays()).toEqual([999]);
    timers.fireLast();
    expect(sockets).toHaveLength(2); // reconnected
  });

  it("re-runs the handshake on every reconnect", () => {
    const { client, sockets, timers } = setup();
    client.start();
    completeHandshake(sockets[0] as FakeSocket);
    expect(sockets[0]?.sent).toHaveLength(1); // hello #1
    sockets[0]?.emitClose();
    timers.fireLast(); // reconnect
    sockets[1]?.emitOpen();
    expect(sockets[1]?.sent).toHaveLength(1); // hello #2 on the fresh socket
  });

  it("reconnects after a close, creating a fresh socket when the timer fires", () => {
    const { client, sockets, timers } = setup();
    client.start();
    expect(sockets).toHaveLength(1);

    sockets[0]?.emitClose();
    expect(timers.reconnectDelays()).toEqual([999]); // attempt 0: ~baseMs ceiling

    timers.fireLast();
    expect(sockets).toHaveLength(2); // reconnected
  });

  it("escalates the backoff delay across successive failed reconnects", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitClose(); // attempt 0
    timers.fireLast();
    sockets[1]?.emitClose(); // attempt 1
    timers.fireLast();
    sockets[2]?.emitClose(); // attempt 2
    expect(timers.reconnectDelays()).toEqual([999, 1999, 3999]);
  });

  it("resets the backoff after a successful open", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitClose(); // attempt 0 -> 999
    timers.fireLast();
    sockets[1]?.emitClose(); // attempt 1 -> 1999
    timers.fireLast();
    sockets[2]?.emitOpen(); // success resets the counter (also sends hello)
    sockets[2]?.emitClose(); // attempt 0 again -> 999
    expect(timers.reconnectDelays()).toEqual([999, 1999, 999]);
  });

  it("stop() cancels a pending reconnect and does not reconnect", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitClose();
    expect(timers.reconnectDelays()).toEqual([999]);

    client.stop();
    const reconnectTimer = timers.scheduled.find((s) => s.ms === 999);
    expect(reconnectTimer?.cleared).toBe(true);
    // A stale timer that somehow still fires is a no-op after stop().
    reconnectTimer?.handler();
    expect(sockets).toHaveLength(1);
  });

  it("stop() terminates the current socket and clears the handshake timer", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitOpen(); // schedules the handshake timer
    client.stop();
    expect(sockets[0]?.terminated).toBe(true);
    const handshakeTimer = timers.scheduled.find((s) => s.ms === DEFAULT_HANDSHAKE_TIMEOUT_MS);
    expect(handshakeTimer?.cleared).toBe(true);
  });

  it("logs but does not reconnect on error alone (close drives reconnect)", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitError(new Error("ECONNREFUSED"));
    expect(timers.reconnectDelays()).toEqual([]);
    sockets[0]?.emitClose();
    expect(timers.reconnectDelays()).toEqual([999]);
  });

  it("fires the onOpen seam on connect (before hello)", () => {
    const onOpen = vi.fn();
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const client = new WsClient({
      url: "wss://d/api/events/stream",
      token: "t",
      agentVersion: "1.0.0",
      onFrame: () => undefined,
      backoff: { baseMs: 1_000, maxMs: 60_000 },
      logger: noopLogger,
      factory,
      timers: new FakeTimers(),
      onOpen,
    });
    client.start();
    sockets[0]?.emitOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.sent).toHaveLength(1); // hello follows the seam
  });
});
