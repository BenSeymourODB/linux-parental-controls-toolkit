import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatcher } from "../../src/bridge/dispatch.js";
import type { Logger } from "../../src/bridge/logger.js";
import type { EventFrame } from "../../src/bridge/protocol.js";

/** A logger that records every call for assertions. */
function testLogger(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const mk =
    (level: string) =>
    (_fields: Record<string, unknown>, msg: string): void => {
      lines.push({ level, msg });
    };
  return { lines, debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") };
}

function frame(userId: number, seq = 1): EventFrame {
  return { seq, at: "2026-06-24T02:00:00.000Z", event: { type: "lockout.cleared", userId } };
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

describe("Dispatcher (real AF_UNIX)", () => {
  let dir: string;
  let log: ReturnType<typeof testLogger>;
  let dispatcher: Dispatcher;

  const socketPath = (uid: number): string => join(dir, `${uid}.sock`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-dispatch-"));
    log = testLogger();
  });

  afterEach(async () => {
    await dispatcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates one listening socket per user and routes a frame by userId", async () => {
    dispatcher = new Dispatcher({
      users: [
        { userId: 7, linuxUid: 1001 },
        { userId: 8, linuxUid: 1002 },
      ],
      socketPath,
      socketMode: 0o600,
      logger: log,
    });
    await dispatcher.start();

    expect(existsSync(socketPath(1001))).toBe(true);
    expect(existsSync(socketPath(1002))).toBe(true);

    const agent7 = await connectAgent(socketPath(1001));
    await tick(); // let the server register the connection
    expect(dispatcher.connectionCount(7)).toBe(1);

    const line = nextLine(agent7);
    const delivered = dispatcher.dispatch(frame(7, 42));
    expect(delivered).toBe(1);
    expect(JSON.parse(await line)).toEqual(frame(7, 42));

    agent7.destroy();
  });

  it("drops a frame for an unmapped userId and logs a warning", () => {
    dispatcher = new Dispatcher({
      users: [{ userId: 7, linuxUid: 1001 }],
      socketPath,
      socketMode: 0o600,
      logger: log,
    });
    // No start() needed: routing is a map lookup; the user is simply absent.
    const delivered = dispatcher.dispatch(frame(999));
    expect(delivered).toBe(0);
    expect(log.lines).toContainEqual({ level: "warn", msg: "dropping frame for unmapped userId" });
  });

  it("drops a frame when the user's agent is not connected", async () => {
    dispatcher = new Dispatcher({
      users: [{ userId: 7, linuxUid: 1001 }],
      socketPath,
      socketMode: 0o600,
      logger: log,
    });
    await dispatcher.start();
    const delivered = dispatcher.dispatch(frame(7));
    expect(delivered).toBe(0);
    expect(log.lines).toContainEqual({ level: "warn", msg: "no agent connected; dropping frame" });
  });

  it("fans a frame out to multiple connected agents for the same user", async () => {
    dispatcher = new Dispatcher({
      users: [{ userId: 7, linuxUid: 1001 }],
      socketPath,
      socketMode: 0o600,
      logger: log,
    });
    await dispatcher.start();
    const a = await connectAgent(socketPath(1001));
    const b = await connectAgent(socketPath(1001));
    await tick();
    expect(dispatcher.connectionCount(7)).toBe(2);

    const lineA = nextLine(a);
    const lineB = nextLine(b);
    expect(dispatcher.dispatch(frame(7, 5))).toBe(2);
    expect(JSON.parse(await lineA).seq).toBe(5);
    expect(JSON.parse(await lineB).seq).toBe(5);
    a.destroy();
    b.destroy();
  });

  it("stops counting a connection after the agent disconnects", async () => {
    dispatcher = new Dispatcher({
      users: [{ userId: 7, linuxUid: 1001 }],
      socketPath,
      socketMode: 0o600,
      logger: log,
    });
    await dispatcher.start();
    const agent = await connectAgent(socketPath(1001));
    await tick();
    expect(dispatcher.connectionCount(7)).toBe(1);

    agent.destroy();
    await tick();
    await tick();
    expect(dispatcher.connectionCount(7)).toBe(0);
  });

  it("removes the socket files on stop", async () => {
    dispatcher = new Dispatcher({
      users: [{ userId: 7, linuxUid: 1001 }],
      socketPath,
      socketMode: 0o600,
      logger: log,
    });
    await dispatcher.start();
    expect(existsSync(socketPath(1001))).toBe(true);
    await dispatcher.stop();
    expect(existsSync(socketPath(1001))).toBe(false);
  });

  it("reclaims a stale socket path left by an unclean shutdown", async () => {
    // Emulate the leftover a crash leaves behind: a file at the socket path
    // that close() never removed. The dispatcher must unlink it and bind anyway
    // rather than failing its first start with EADDRINUSE.
    writeFileSync(socketPath(1001), "stale");
    dispatcher = new Dispatcher({
      users: [{ userId: 7, linuxUid: 1001 }],
      socketPath,
      socketMode: 0o600,
      logger: log,
    });
    await expect(dispatcher.start()).resolves.toBeUndefined();
    // A connecting agent proves it's now a live listening socket, not the file.
    const agent = await connectAgent(socketPath(1001));
    await tick();
    expect(dispatcher.connectionCount(7)).toBe(1);
    agent.destroy();
  });
});
