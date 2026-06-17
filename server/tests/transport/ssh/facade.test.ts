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

interface MockState {
  connect: "ready" | "error";
  connectError: Error;
  exec: ExecBehavior;
  instances: FakeClient[];
  connectCalls: number;
}

const state: MockState = {
  connect: "ready",
  connectError: new Error("ECONNREFUSED"),
  exec: { code: 0 },
  instances: [],
  connectCalls: 0,
};

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
} = await import("../../../src/transport/ssh/index.js");

const target = { host: "client.local", username: "pct-agent", privateKey: "PRIVATE-KEY" };

beforeEach(() => {
  state.connect = "ready";
  state.connectError = new Error("ECONNREFUSED");
  state.exec = { code: 0 };
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
});
