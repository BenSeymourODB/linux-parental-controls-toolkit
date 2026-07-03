import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatcher } from "../../src/bridge/dispatch.js";
import { StreamLogger, type Logger } from "../../src/bridge/logger.js";
import type { EventFrame, ServerEvent } from "../../src/bridge/protocol.js";
import type { Scheduler, TimerHandle } from "../../src/agent/scheduler.js";
import {
  AgentSocketClient,
  type SocketFactory,
  type SocketLike,
} from "../../src/agent/socket-client.js";

const noop = (): void => undefined;
const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
const backoff = { baseMs: 1, maxMs: 10 };

const frameLine = (event: ServerEvent, seq = 1): string =>
  JSON.stringify({ seq, at: "2026-07-03T12:00:00.000Z", event } satisfies EventFrame) + "\n";

/** A controllable in-memory socket matching {@link SocketLike}'s overloads. */
class FakeSocket implements SocketLike {
  #connect?: () => void;
  #close?: () => void;
  #data?: (chunk: Buffer) => void;
  #error?: (err: Error) => void;
  destroyed = false;

  on(event: "connect" | "close", listener: () => void): this;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "connect" | "close" | "data" | "error",
    listener: (() => void) | ((chunk: Buffer) => void) | ((err: Error) => void),
  ): this {
    if (event === "connect") this.#connect = listener as () => void;
    else if (event === "close") this.#close = listener as () => void;
    else if (event === "data") this.#data = listener as (chunk: Buffer) => void;
    else this.#error = listener as (err: Error) => void;
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
  emitConnect(): void {
    this.#connect?.();
  }
  emitData(chunk: Buffer): void {
    this.#data?.(chunk);
  }
  emitClose(): void {
    this.#close?.();
  }
  emitError(err: Error): void {
    this.#error?.(err);
  }
}

/** Records scheduled timeouts so a reconnect can be triggered on demand. */
class FakeScheduler implements Scheduler {
  timeouts: (() => void)[] = [];
  cancelled = 0;
  interval(): TimerHandle {
    return { token: Symbol() };
  }
  timeout(callback: () => void): TimerHandle {
    this.timeouts.push(callback);
    return { token: Symbol() };
  }
  cancel(): void {
    this.cancelled += 1;
  }
}

describe("AgentSocketClient (fake socket)", () => {
  it("decodes multiple newline-delimited frames from one chunk", () => {
    let socket: FakeSocket | undefined;
    const factory: SocketFactory = () => (socket = new FakeSocket());
    const events: ServerEvent[] = [];
    const client = new AgentSocketClient({
      socketPath: "/x.sock",
      onEvent: (e) => events.push(e),
      backoff,
      scheduler: new FakeScheduler(),
      logger: silentLogger,
      factory,
    });
    client.start();
    socket?.emitConnect();
    socket?.emitData(
      Buffer.from(
        frameLine({ type: "lockout.cleared", userId: 1 }, 1) +
          frameLine({ type: "enforce.session_lock", userId: 1 }, 2),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["lockout.cleared", "enforce.session_lock"]);
  });

  it("reassembles a frame split across two chunks", () => {
    let socket: FakeSocket | undefined;
    const factory: SocketFactory = () => (socket = new FakeSocket());
    const events: ServerEvent[] = [];
    const client = new AgentSocketClient({
      socketPath: "/x.sock",
      onEvent: (e) => events.push(e),
      backoff,
      scheduler: new FakeScheduler(),
      logger: silentLogger,
      factory,
    });
    client.start();
    const line = frameLine({ type: "lockout.cleared", userId: 1 });
    socket?.emitData(Buffer.from(line.slice(0, 10)));
    socket?.emitData(Buffer.from(line.slice(10)));
    expect(events).toHaveLength(1);
  });

  it("drops a malformed frame without tearing down the connection", () => {
    let socket: FakeSocket | undefined;
    const factory: SocketFactory = () => (socket = new FakeSocket());
    const events: ServerEvent[] = [];
    const client = new AgentSocketClient({
      socketPath: "/x.sock",
      onEvent: (e) => events.push(e),
      backoff,
      scheduler: new FakeScheduler(),
      logger: silentLogger,
      factory,
    });
    client.start();
    socket?.emitData(Buffer.from("{not json}\n"));
    socket?.emitData(Buffer.from(frameLine({ type: "lockout.cleared", userId: 1 })));
    expect(events).toHaveLength(1);
  });

  it("schedules a reconnect on close and stops cleanly", () => {
    const sockets: FakeSocket[] = [];
    const factory: SocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const scheduler = new FakeScheduler();
    const client = new AgentSocketClient({
      socketPath: "/x.sock",
      onEvent: () => undefined,
      backoff,
      scheduler,
      logger: silentLogger,
      factory,
    });
    client.start();
    sockets[0]?.emitError(new Error("boom"));
    sockets[0]?.emitClose();
    expect(scheduler.timeouts).toHaveLength(1);
    scheduler.timeouts[0]?.(); // fire the reconnect
    expect(sockets).toHaveLength(2);
    client.stop();
    expect(sockets[1]?.destroyed).toBe(true);
  });
});

describe("AgentSocketClient (real bridge Dispatcher)", () => {
  let dir: string;
  let dispatcher: Dispatcher;
  let client: AgentSocketClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-agent-sock-"));
  });
  afterEach(async () => {
    client.stop();
    await dispatcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("receives a frame the bridge dispatches over a real AF_UNIX socket", async () => {
    const socketPath = join(dir, "1001.sock");
    dispatcher = new Dispatcher({
      users: [{ userId: 42, linuxUid: 1001 }],
      socketPath: () => socketPath,
      socketMode: 0o600,
      logger: new StreamLogger({
        sinks: { out: { write: () => undefined }, err: { write: () => undefined } },
      }),
    });
    await dispatcher.start();

    const received: ServerEvent[] = [];
    client = new AgentSocketClient({
      socketPath,
      onEvent: (e) => received.push(e),
      backoff,
      scheduler: new FakeScheduler(),
      logger: silentLogger,
    });
    client.start();

    await waitFor(() => dispatcher.connectionCount(42) === 1);
    dispatcher.dispatch({
      seq: 1,
      at: "2026-07-03T12:00:00.000Z",
      event: {
        type: "grant.applied",
        userId: 42,
        grantedSeconds: 600,
        reason: "chores",
        activityId: null,
      },
    });
    await waitFor(() => received.length === 1);

    expect(received[0]).toMatchObject({ type: "grant.applied", grantedSeconds: 600 });
  });
});

/** Poll `predicate` until true (or a short timeout), for the live socket test. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
