import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Bridge } from "../../src/bridge/bridge.js";
import { bridgeConfigSchema, type BridgeConfig } from "../../src/bridge/config.js";
import type { Logger } from "../../src/bridge/logger.js";
import type { EventFrame } from "../../src/bridge/protocol.js";
import type { WebSocketFactory, WebSocketLike } from "../../src/bridge/ws-client.js";

type RawMessage = string | Buffer | ArrayBuffer | Buffer[];

/** A logger that records every call for assertions. */
function testLogger(): Logger {
  const lines: { level: string; msg: string }[] = [];
  const mk =
    (level: string) =>
    (_fields: Record<string, unknown>, msg: string): void => {
      lines.push({ level, msg });
    };
  return { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") };
}

/** A controllable fake WebSocket: records listeners, exposes hand-fired emitters. */
class FakeSocket implements WebSocketLike {
  #open?: () => void;
  #message?: (data: RawMessage) => void;
  #close?: () => void;
  terminated = false;

  on(event: "open" | "close", listener: () => void): this;
  on(event: "message", listener: (data: RawMessage) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "open" | "message" | "close" | "error",
    listener: (() => void) | ((data: RawMessage) => void) | ((err: Error) => void),
  ): this {
    if (event === "open") this.#open = listener as () => void;
    else if (event === "message") this.#message = listener as (data: RawMessage) => void;
    else if (event === "close") this.#close = listener as () => void;
    return this;
  }
  closed = false;
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
}

/** Connect a fake agent to `path` and resolve once connected. */
function connectAgent(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Read the next newline-delimited frame line the agent receives. */
function nextLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        socket.off("data", onData);
        resolve(buf.slice(0, nl));
      }
    };
    socket.on("data", onData);
  });
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function frame(userId: number, seq = 1): EventFrame {
  return {
    seq,
    at: "2026-06-24T02:00:00.000Z",
    event: { type: "policy.changed", userId, summary: "Your YouTube limit is now 1h" },
  };
}

describe("Bridge (fake WS → real AF_UNIX)", () => {
  let dir: string;
  let config: BridgeConfig;

  function makeConfig(): BridgeConfig {
    return bridgeConfigSchema.parse({
      serverUrl: "wss://dash.example/api/events/stream",
      token: "tok-123",
      socketDir: dir,
      users: [
        { userId: 7, linuxUid: 1001 },
        { userId: 8, linuxUid: 1002 },
      ],
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-bridge-"));
    config = makeConfig();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds per-user sockets before opening the stream, then routes a frame end to end", async () => {
    const sockets: FakeSocket[] = [];
    const order: string[] = [];
    const factory: WebSocketFactory = (url, opts) => {
      order.push("ws-created");
      expect(url).toBe(config.serverUrl);
      expect(opts.headers.Authorization).toBe("Bearer tok-123");
      // The WS must not be created until the per-user sockets are bound — pin
      // the ordering at the moment the factory runs, not just after start().
      expect(existsSync(join(dir, "1001.sock"))).toBe(true);
      expect(existsSync(join(dir, "1002.sock"))).toBe(true);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };

    const bridge = new Bridge(config, { logger: testLogger(), wsFactory: factory });

    await bridge.start();
    expect(existsSync(join(dir, "1001.sock"))).toBe(true);
    expect(existsSync(join(dir, "1002.sock"))).toBe(true);
    expect(order).toEqual(["ws-created"]);

    const agent = await connectAgent(join(dir, "1001.sock"));
    await tick();
    expect(bridge.dispatcher.connectionCount(7)).toBe(1);

    const fakeWs = sockets[0];
    expect(fakeWs).toBeDefined();
    fakeWs?.emitOpen();

    const line = nextLine(agent);
    fakeWs?.emitMessage(JSON.stringify(frame(7, 42)));
    expect(JSON.parse(await line)).toEqual(frame(7, 42));

    agent.destroy();
    await bridge.stop();
  });

  it("fires the onOpen handshake seam on connect", async () => {
    const onOpen = vi.fn();
    let fakeWs: FakeSocket | undefined;
    const factory: WebSocketFactory = () => {
      fakeWs = new FakeSocket();
      return fakeWs;
    };

    const bridge = new Bridge(config, { logger: testLogger(), wsFactory: factory, onOpen });
    await bridge.start();
    expect(onOpen).not.toHaveBeenCalled();
    fakeWs?.emitOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    await bridge.stop();
  });

  it("tears down the stream and the sockets on stop", async () => {
    let fakeWs: FakeSocket | undefined;
    const factory: WebSocketFactory = () => {
      fakeWs = new FakeSocket();
      return fakeWs;
    };

    const bridge = new Bridge(config, { logger: testLogger(), wsFactory: factory });
    await bridge.start();
    expect(existsSync(join(dir, "1001.sock"))).toBe(true);

    await bridge.stop();
    expect(fakeWs?.terminated).toBe(true);
    expect(existsSync(join(dir, "1001.sock"))).toBe(false);
    expect(existsSync(join(dir, "1002.sock"))).toBe(false);
  });

  it("drops a frame addressed to an unmapped user without throwing", async () => {
    let fakeWs: FakeSocket | undefined;
    const factory: WebSocketFactory = () => {
      fakeWs = new FakeSocket();
      return fakeWs;
    };
    const bridge = new Bridge(config, { logger: testLogger(), wsFactory: factory });
    await bridge.start();
    fakeWs?.emitOpen();

    // userId 999 is not in the config; this must be a silent no-op, not a throw.
    expect(() => fakeWs?.emitMessage(JSON.stringify(frame(999)))).not.toThrow();
    await bridge.stop();
  });
});
