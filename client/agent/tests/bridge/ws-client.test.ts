import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/bridge/logger.js";
import type { EventFrame } from "../../src/bridge/protocol.js";
import {
  WsClient,
  type Timers,
  type WebSocketFactory,
  type WebSocketLike,
} from "../../src/bridge/ws-client.js";

type RawMessage = string | Buffer | ArrayBuffer | Buffer[];

/** A controllable fake socket that records listeners and exposes emitters. */
class FakeSocket implements WebSocketLike {
  #open?: () => void;
  #message?: (data: RawMessage) => void;
  #close?: () => void;
  #error?: (err: Error) => void;
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
}): WsClient {
  return new WsClient({
    url: "wss://dash.example/api/events/stream",
    token: "tok_abc",
    onFrame: opts.onFrame,
    backoff: { baseMs: 1_000, maxMs: 60_000 },
    logger: opts.logger ?? noopLogger,
    factory: opts.factory,
    timers: opts.timers,
    rng: opts.rng,
  });
}

const sampleFrame = (seq = 1): EventFrame => ({
  seq,
  at: "2026-06-24T02:00:00.000Z",
  event: { type: "policy.changed", userId: 7, summary: "1h now" },
});

describe("WsClient", () => {
  it("connects with the Authorization: Bearer header", () => {
    const { client, headers } = setup();
    client.start();
    expect(headers).toHaveLength(1);
    expect(headers[0]).toEqual({ Authorization: "Bearer tok_abc" });
  });

  it("decodes an inbound message and forwards the frame", () => {
    const { client, sockets, frames } = setup();
    client.start();
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage(JSON.stringify(sampleFrame(9)));
    expect(frames).toEqual([sampleFrame(9)]);
  });

  it("decodes a Buffer message the same as a string", () => {
    const { client, sockets, frames } = setup();
    client.start();
    sockets[0]?.emitMessage(Buffer.from(JSON.stringify(sampleFrame(3)), "utf8"));
    expect(frames).toEqual([sampleFrame(3)]);
  });

  it("drops a malformed frame without throwing or forwarding", () => {
    const warn = vi.fn();
    const { client, sockets, frames } = setup({
      logger: { ...noopLogger, warn },
    });
    client.start();
    expect(() => sockets[0]?.emitMessage("{not json")).not.toThrow();
    expect(frames).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.anything(), "dropping undecodable frame");
  });

  it("reconnects after a close, creating a fresh socket when the timer fires", () => {
    const { client, sockets, timers } = setup();
    client.start();
    expect(sockets).toHaveLength(1);

    sockets[0]?.emitClose();
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0]?.ms).toBe(999); // attempt 0: ~baseMs ceiling

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
    expect(timers.scheduled.map((s) => s.ms)).toEqual([999, 1999, 3999]);
  });

  it("resets the backoff after a successful open", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitClose(); // attempt 0 -> 999
    timers.fireLast();
    sockets[1]?.emitClose(); // attempt 1 -> 1999
    timers.fireLast();
    sockets[2]?.emitOpen(); // success resets the counter
    sockets[2]?.emitClose(); // attempt 0 again -> 999
    expect(timers.scheduled.map((s) => s.ms)).toEqual([999, 1999, 999]);
  });

  it("stop() cancels a pending reconnect and does not reconnect", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitClose();
    expect(timers.scheduled).toHaveLength(1);

    client.stop();
    expect(timers.scheduled[0]?.cleared).toBe(true);
    // A stale timer that somehow still fires is a no-op after stop().
    timers.scheduled[0]?.handler();
    expect(sockets).toHaveLength(1);
  });

  it("stop() terminates the current socket", () => {
    const { client, sockets } = setup();
    client.start();
    client.stop();
    expect(sockets[0]?.terminated).toBe(true);
  });

  it("logs but does not reconnect on error alone (close drives reconnect)", () => {
    const { client, sockets, timers } = setup();
    client.start();
    sockets[0]?.emitError(new Error("ECONNREFUSED"));
    expect(timers.scheduled).toHaveLength(0);
    sockets[0]?.emitClose();
    expect(timers.scheduled).toHaveLength(1);
  });

  it("fires the onOpen handshake seam on connect", () => {
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
  });
});
