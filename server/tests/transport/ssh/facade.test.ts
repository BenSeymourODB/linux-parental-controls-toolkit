/**
 * Unit tests for the SSH transport facade.
 *
 * `ssh2` is mocked at the module level (mirroring the repo's
 * `vi.mock("node:child_process")` pattern in `tests/helpers/subprocess.ts`):
 * a fake `Client` whose connect/exec behaviour each test drives through the
 * shared {@link state}, plus a fake exec channel that emits `data` / `exit` /
 * `close` like a real `ClientChannel`. No real socket is ever opened.
 */
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** How the fake exec channel should behave for the command under test. */
interface ExecBehavior {
  /** Fail the `exec` request itself (channel never opens). */
  err?: Error;
  /** Bytes to emit on stdout before close. */
  stdout?: string;
  /** Bytes to emit on stderr before close. */
  stderr?: string;
  /** Exit code (default 0); ignored when {@link signal} is set. */
  code?: number | null;
  /** Terminating signal (sets the exit `code` to null, as ssh2 does). */
  signal?: string;
  /** Never emit `exit`/`close` — used to exercise the per-exec timeout. */
  hang?: boolean;
  /** Emit `close` with no preceding `exit` — a mid-command session drop. */
  closeWithoutExit?: boolean;
}

/** How the fake `forwardOut` request should behave for the test. */
interface ForwardBehavior {
  /** Fail the forward request itself (no channel is opened). */
  err?: Error;
}

interface MockState {
  connect: "ready" | "error";
  connectError: Error;
  exec: ExecBehavior;
  forward: ForwardBehavior;
  instances: FakeClient[];
  connectCalls: number;
}

const state: MockState = {
  connect: "ready",
  connectError: new Error("ECONNREFUSED"),
  exec: { code: 0 },
  forward: {},
  instances: [],
  connectCalls: 0,
};

/** One recorded `forwardOut` request's destination + source descriptor. */
interface ForwardRecord {
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
}

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeClient extends EventEmitter {
  connectConfig: Record<string, unknown> | undefined;
  ended = false;
  readonly execCommands: string[] = [];
  readonly channels: FakeChannel[] = [];
  readonly forwardOuts: ForwardRecord[] = [];
  readonly forwardChannels: PassThrough[] = [];

  // A real `ssh2` channel is a duplex stream; a PassThrough is a faithful
  // stand-in that, wired as `socket.pipe(channel); channel.pipe(socket)`,
  // echoes bytes straight back — so a loopback round-trip exercises the real
  // piping/teardown logic without a remote.
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined, channel?: PassThrough) => void,
  ): this {
    this.forwardOuts.push({ srcIP, srcPort, dstIP, dstPort });
    const behavior = state.forward;
    queueMicrotask(() => {
      if (behavior.err !== undefined) {
        cb(behavior.err);
        return;
      }
      const channel = new PassThrough();
      this.forwardChannels.push(channel);
      cb(undefined, channel);
    });
    return this;
  }

  connect(config: Record<string, unknown>): this {
    this.connectConfig = config;
    state.connectCalls += 1;
    state.instances.push(this);
    queueMicrotask(() => {
      if (state.connect === "ready") this.emit("ready");
      else this.emit("error", state.connectError);
    });
    return this;
  }

  exec(command: string, cb: (err: Error | undefined, channel: FakeChannel) => void): this {
    this.execCommands.push(command);
    const channel = new FakeChannel();
    this.channels.push(channel);
    const behavior = state.exec;
    queueMicrotask(() => {
      if (behavior.err !== undefined) {
        cb(behavior.err, channel);
        return;
      }
      cb(undefined, channel);
      queueMicrotask(() => {
        if (behavior.stdout !== undefined) channel.emit("data", Buffer.from(behavior.stdout));
        if (behavior.stderr !== undefined)
          channel.stderr.emit("data", Buffer.from(behavior.stderr));
        if (behavior.hang === true) return;
        if (behavior.closeWithoutExit !== true) {
          if (behavior.signal !== undefined) channel.emit("exit", null, behavior.signal);
          else channel.emit("exit", behavior.code ?? 0);
        }
        channel.emit("close");
      });
    });
    return this;
  }

  end(): this {
    this.ended = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

const mockSsh = { module: { Client: FakeClient } };
vi.mock("ssh2", () => mockSsh.module);

const {
  SshTransport,
  SshUnreachableError,
  SshCommandError,
  SshParseError,
  SshExecTimeoutError,
  targetFromClient,
  sshHostForClient,
} = await import("../../../src/transport/ssh/index.js");

const target = { host: "client.local", username: "pct-agent", privateKey: "PRIVATE-KEY" };

beforeEach(() => {
  state.connect = "ready";
  state.connectError = new Error("ECONNREFUSED");
  state.exec = { code: 0 };
  state.forward = {};
  state.instances = [];
  state.connectCalls = 0;
});

describe("SshTransport.exec", () => {
  it("returns the captured stdout, stderr, and a zero exit code", async () => {
    state.exec = { stdout: "hello\n", stderr: "note\n", code: 0 };
    const transport = new SshTransport();

    const result = await transport.exec(target, ["echo", "hello"]);

    expect(result).toEqual({ stdout: "hello\n", stderr: "note\n", code: 0, signal: null });
  });

  it("passes arguments as a shell-quoted vector, never raw", async () => {
    const transport = new SshTransport();

    await transport.exec(target, ["timekpra", "--settimelimitforday", "alice", "7200"]);

    const instance = state.instances[0];
    expect(instance?.execCommands[0]).toBe("'timekpra' '--settimelimitforday' 'alice' '7200'");
  });

  it("reports a non-zero exit code without throwing", async () => {
    state.exec = { code: 3, stderr: "nope" };
    const transport = new SshTransport();

    const result = await transport.exec(target, ["false"]);

    expect(result.code).toBe(3);
    expect(result.stderr).toBe("nope");
  });

  it("normalises a signal kill to code null + signal name", async () => {
    state.exec = { signal: "SIGKILL" };
    const transport = new SshTransport();

    const result = await transport.exec(target, ["sleep", "1"]);

    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  });

  it("defaults the port to 22 and applies the ready timeout in the connect config", async () => {
    const transport = new SshTransport({ readyTimeoutMs: 4321 });

    await transport.exec(target, ["true"]);

    expect(state.instances[0]?.connectConfig).toMatchObject({
      host: "client.local",
      port: 22,
      username: "pct-agent",
      privateKey: "PRIVATE-KEY",
      readyTimeout: 4321,
    });
  });

  it("rejects with SshUnreachableError when the host can't be reached", async () => {
    state.connect = "error";
    const transport = new SshTransport();

    const error = await transport.exec(target, ["true"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshUnreachableError);
    expect(error).toMatchObject({ retriable: true });
    expect(transport.connectionCount).toBe(0);
  });

  it("preserves the underlying connect error as the cause", async () => {
    state.connect = "error";
    const boom = new Error("ECONNREFUSED boom");
    state.connectError = boom;
    const transport = new SshTransport();

    const error = await transport.exec(target, ["true"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshUnreachableError);
    if (error instanceof SshUnreachableError) expect(error.cause).toBe(boom);
  });

  it("treats an exec-request failure as unreachable and evicts the connection", async () => {
    state.exec = { err: new Error("channel open failure") };
    const transport = new SshTransport();

    const error = await transport.exec(target, ["true"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshUnreachableError);
    expect(transport.connectionCount).toBe(0);
  });

  it("treats a channel that closes without an exit status as unreachable", async () => {
    // A mid-command session drop: bytes arrive, then `close` with no `exit`.
    // This must not be reported as a clean signal-kill (`code: null`).
    state.exec = { stdout: "partial output", closeWithoutExit: true };
    const transport = new SshTransport();

    const error = await transport.exec(target, ["timekpra", "--get"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshUnreachableError);
    expect(error).toMatchObject({ retriable: true });
    expect(transport.connectionCount).toBe(0);
  });

  it("evicts the pooled connection on a post-ready error event", async () => {
    const transport = new SshTransport();
    await transport.exec(target, ["true"]);
    expect(transport.connectionCount).toBe(1);

    // The session errors out after it was established.
    state.instances[0]?.emit("error", new Error("connection reset"));

    expect(transport.connectionCount).toBe(0);
    await transport.exec(target, ["true"]);
    expect(state.connectCalls).toBe(2);
  });

  it("absorbs a repeated error event without an unhandled-error crash", async () => {
    // ssh2 can emit `error` more than once when a peer drops the connection
    // (e.g. before the SSH handshake). The facade listens with `on`, not a
    // one-shot listener, so the second emit is handled rather than surfacing as
    // an unhandled 'error' event (which EventEmitter throws on). A regression to
    // `once` would make the second `emit` below throw.
    const transport = new SshTransport();
    await transport.exec(target, ["true"]);
    const client = state.instances[0];

    expect(() => {
      client?.emit("error", new Error("Connection lost before handshake"));
      client?.emit("error", new Error("Connection lost before handshake"));
    }).not.toThrow();
    expect(transport.connectionCount).toBe(0);
  });

  it("opens a single connection for calls issued before the first is ready", async () => {
    const transport = new SshTransport();

    // Both exec calls race the same pending connect; they must share it.
    await Promise.all([transport.exec(target, ["true"]), transport.exec(target, ["true"])]);

    expect(state.connectCalls).toBe(1);
    expect(transport.connectionCount).toBe(1);
  });

  it("reuses one pooled connection across calls to the same target", async () => {
    const transport = new SshTransport();

    await transport.exec(target, ["true"]);
    await transport.exec(target, ["true"]);

    expect(state.connectCalls).toBe(1);
    expect(transport.connectionCount).toBe(1);
  });

  it("reconnects after the connection drops", async () => {
    const transport = new SshTransport();
    await transport.exec(target, ["true"]);

    // Simulate the server dropping the session.
    state.instances[0]?.emit("close");
    expect(transport.connectionCount).toBe(0);

    await transport.exec(target, ["true"]);
    expect(state.connectCalls).toBe(2);
  });

  it("aborts and rejects with SshExecTimeoutError when a command hangs", async () => {
    state.exec = { hang: true };
    const transport = new SshTransport();

    const error = await transport
      .exec(target, ["sleep", "100"], { timeoutMs: 10 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshExecTimeoutError);
    expect(error).toMatchObject({ retriable: true, timeoutMs: 10 });
    expect(state.instances[0]?.channels[0]?.destroyed).toBe(true);
    // The connection stays pooled — the host is reachable, only the command
    // hung. Eviction is centralised in #exec on SshUnreachableError (#306), so
    // a timeout must NOT evict; a follow-up exec reuses the same connection.
    expect(transport.connectionCount).toBe(1);
    state.exec = { code: 0 };
    await transport.exec(target, ["true"]);
    expect(state.connectCalls).toBe(1);
  });
});

describe("SshTransport.execChecked", () => {
  it("resolves when the command exits zero", async () => {
    state.exec = { stdout: "ok", code: 0 };
    const transport = new SshTransport();

    const result = await transport.execChecked(target, ["true"]);

    expect(result.stdout).toBe("ok");
  });

  it("throws SshCommandError carrying argv, code, and stderr on non-zero exit", async () => {
    state.exec = { code: 2, stderr: "boom" };
    const transport = new SshTransport();
    const argv = ["timekpra", "--bad"];

    const error = await transport.execChecked(target, argv).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshCommandError);
    expect(error).toMatchObject({ retriable: false, code: 2, stderr: "boom", argv });
  });

  it("throws SshCommandError naming the signal when the command is killed", async () => {
    state.exec = { signal: "SIGKILL" };
    const transport = new SshTransport();

    const error = await transport.execChecked(target, ["timekpra"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshCommandError);
    expect(error).toMatchObject({ code: null, signal: "SIGKILL" });
    // The status string names the signal rather than rendering "signal null".
    if (error instanceof SshCommandError) expect(error.message).toContain("signal SIGKILL");
  });
});

describe("SshTransport.execAndParse", () => {
  it("validates stdout through the supplied zod schema and returns typed data", async () => {
    state.exec = { stdout: "  alice 0 7200  \n", code: 0 };
    const transport = new SshTransport();
    const schema = z.string().transform((s) => s.trim());

    const parsed = await transport.execAndParse(target, ["timekpra", "--get"], schema);

    expect(parsed).toBe("alice 0 7200");
  });

  it("throws SshParseError when stdout doesn't match the schema", async () => {
    state.exec = { stdout: "garbage", code: 0 };
    const transport = new SshTransport();
    const schema = z.string().refine((s) => s.startsWith("EXPECTED"), "bad shape");

    const error = await transport
      .execAndParse(target, ["timekpra", "--get"], schema)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshParseError);
    expect(error).toMatchObject({ stdout: "garbage", retriable: false });
    if (error instanceof SshParseError) {
      expect(error.cause).toBeInstanceOf(z.ZodError);
    }
  });
});

/** Connect to a loopback port, send `message`, resolve with the echoed bytes. */
function roundTrip(port: number, message: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(message));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

/** Connect, send a byte, resolve once the connection is closed (reset). */
function dropOnConnect(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("ping"));
    socket.on("close", () => resolve());
    socket.on("error", () => undefined);
  });
}

/** Resolve if a connect to `port` is refused (the listener is gone). */
function expectRefused(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      reject(new Error(`expected connection to ${port} to be refused`));
    });
    socket.on("error", () => resolve());
  });
}

describe("SshTransport.withPortForward", () => {
  it("forwards a loopback connection over the SSH session, then tears down", async () => {
    const transport = new SshTransport();
    let chosenPort = 0;

    const echoed = await transport.withPortForward(
      target,
      { port: 5600 },
      async (local) => {
        expect(local.host).toBe("127.0.0.1");
        chosenPort = local.port;
        return roundTrip(local.port, "ping");
      },
      { localPort: 0 },
    );

    expect(echoed).toBe("ping");
    // The forward targeted the requested remote endpoint (loopback default).
    expect(state.instances[0]?.forwardOuts[0]).toMatchObject({ dstIP: "127.0.0.1", dstPort: 5600 });
    // The listener is closed once the window ends — connecting is now refused.
    await expectRefused(chosenPort);
  });

  it("defaults the remote host to loopback and honours an explicit one", async () => {
    const transport = new SshTransport();

    await transport.withPortForward(target, { host: "10.0.0.5", port: 5600 }, async (local) => {
      // forwardOut only fires per incoming connection — make one.
      await roundTrip(local.port, "x");
    });

    expect(state.instances[0]?.forwardOuts[0]).toMatchObject({ dstIP: "10.0.0.5", dstPort: 5600 });
  });

  it("destroys the forwarded SSH channel on teardown (no channel leak)", async () => {
    const transport = new SshTransport();

    await transport.withPortForward(target, { port: 5600 }, async (local) => {
      // Hold the connection open (never end it) so the channel can't close
      // from EOF — only the teardown can destroy it. The echoed byte confirms
      // the socket↔channel↔socket loop is wired before the window ends.
      await new Promise<void>((resolve, reject) => {
        const socket = connect(local.port, "127.0.0.1", () => socket.write("ping"));
        socket.once("data", () => resolve());
        socket.on("error", reject);
      });
    });

    const channel = state.instances[0]?.forwardChannels[0];
    expect(channel).toBeDefined();
    expect(channel?.destroyed).toBe(true);
  });

  it("drops a connection whose forward fails without sinking the window", async () => {
    state.forward = { err: new Error("forward refused") };
    const transport = new SshTransport();

    const result = await transport.withPortForward(target, { port: 5600 }, async (local) => {
      await dropOnConnect(local.port);
      return "fn-still-ran";
    });

    expect(result).toBe("fn-still-ran");
  });

  it("propagates the callback's rejection and still tears the listener down", async () => {
    const transport = new SshTransport();
    let chosenPort = 0;

    const error = await transport
      .withPortForward(target, { port: 5600 }, async (local) => {
        chosenPort = local.port;
        throw new Error("consumer boom");
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).toBe("consumer boom");
    await expectRefused(chosenPort);
  });

  it("rejects with SshUnreachableError and never runs the callback when unreachable", async () => {
    state.connect = "error";
    const transport = new SshTransport();
    const fn = vi.fn();

    const error = await transport
      .withPortForward(target, { port: 5600 }, fn)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshUnreachableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("reuses the pooled connection shared with exec", async () => {
    const transport = new SshTransport();

    await transport.exec(target, ["true"]);
    await transport.withPortForward(target, { port: 5600 }, async () => undefined);

    expect(state.connectCalls).toBe(1);
    expect(transport.connectionCount).toBe(1);
  });
});

describe("SshTransport disposal", () => {
  it("dispose() ends and forgets the pooled connection", async () => {
    const transport = new SshTransport();
    await transport.exec(target, ["true"]);

    transport.dispose(target);

    expect(state.instances[0]?.ended).toBe(true);
    expect(transport.connectionCount).toBe(0);
  });

  it("dispose() on an unknown target is a no-op", () => {
    const transport = new SshTransport();
    expect(() => transport.dispose(target)).not.toThrow();
    expect(transport.connectionCount).toBe(0);
  });

  it("disposeAll() ends every pooled connection", async () => {
    const transport = new SshTransport();
    await transport.exec(target, ["true"]);
    await transport.exec({ ...target, host: "other.local" }, ["true"]);
    expect(transport.connectionCount).toBe(2);

    transport.disposeAll();

    expect(state.instances.every((c) => c.ended)).toBe(true);
    expect(transport.connectionCount).toBe(0);
  });
});

describe("targetFromClient", () => {
  it("maps a clients row to a target with key-based credentials", () => {
    const result = targetFromClient(
      { hostname: "mint-01", sshUser: "pct-agent" },
      { privateKey: "KEY" },
    );

    expect(result).toEqual({ host: "mint-01", username: "pct-agent", privateKey: "KEY" });
  });

  it("carries an explicit port and passphrase when supplied", () => {
    const result = targetFromClient(
      { hostname: "mint-01", sshUser: "pct-agent" },
      { privateKey: "KEY", port: 2222, passphrase: "secret" },
    );

    expect(result).toEqual({
      host: "mint-01",
      username: "pct-agent",
      privateKey: "KEY",
      port: 2222,
      passphrase: "secret",
    });
  });

  it("dials the SSH-target override in preference to the hostname (#406)", () => {
    const result = targetFromClient(
      { hostname: "mint-01", sshUser: "pct-agent", sshTarget: "192.168.1.42" },
      { privateKey: "KEY" },
    );

    expect(result.host).toBe("192.168.1.42");
  });

  it("falls back to the hostname when the override is null (#406)", () => {
    const result = targetFromClient(
      { hostname: "mint-01", sshUser: "pct-agent", sshTarget: null },
      { privateKey: "KEY" },
    );

    expect(result.host).toBe("mint-01");
  });
});

describe("sshHostForClient", () => {
  it("returns the override when set", () => {
    expect(sshHostForClient({ hostname: "mint-01", sshTarget: "10.0.0.5" })).toBe("10.0.0.5");
  });

  it("returns the hostname when the override is null or absent", () => {
    expect(sshHostForClient({ hostname: "mint-01", sshTarget: null })).toBe("mint-01");
    expect(sshHostForClient({ hostname: "mint-01" })).toBe("mint-01");
  });
});
