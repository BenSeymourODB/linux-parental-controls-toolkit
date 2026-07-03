/**
 * Focused unit tests for {@link ExecBuffer} — the exec stream-capture / timeout
 * / error-translation unit extracted from the SSH facade (#306).
 *
 * The buffer consumes only a structural `exec`-capable client + channel, so
 * these tests drive a lightweight fake directly (no `ssh2`, no socket, no
 * `as` cast). The facade's own suite covers the same behaviours end-to-end
 * through `SshTransport`; these assert the unit in isolation.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  SshExecTimeoutError,
  SshUnreachableError,
  type SshTargetRef,
} from "../../../src/transport/ssh/errors.js";
import {
  ExecBuffer,
  type ExecCapableClient,
  type ExecChannel,
} from "../../../src/transport/ssh/exec-buffer.js";

const ref: SshTargetRef = { host: "client.local", port: 22, username: "pct-agent" };

/** How the fake channel behaves for the command under test (mirrors facade.test.ts). */
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

class FakeChannel extends EventEmitter implements ExecChannel {
  readonly stderr = new EventEmitter();
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeExecClient extends EventEmitter implements ExecCapableClient {
  readonly commands: string[] = [];
  readonly channels: FakeChannel[] = [];

  constructor(private readonly behavior: ExecBehavior) {
    super();
  }

  exec(command: string, cb: (err: Error | undefined, channel: ExecChannel) => void): this {
    this.commands.push(command);
    const channel = new FakeChannel();
    this.channels.push(channel);
    const b = this.behavior;
    queueMicrotask(() => {
      if (b.err !== undefined) {
        cb(b.err, channel);
        return;
      }
      cb(undefined, channel);
      queueMicrotask(() => {
        if (b.stdout !== undefined) channel.emit("data", Buffer.from(b.stdout));
        if (b.stderr !== undefined) channel.stderr.emit("data", Buffer.from(b.stderr));
        if (b.hang === true) return;
        if (b.closeWithoutExit !== true) {
          if (b.signal !== undefined) channel.emit("exit", null, b.signal);
          else channel.emit("exit", b.code ?? 0);
        }
        channel.emit("close");
      });
    });
    return this;
  }
}

/** Build a fake client + run one buffered exec against it. */
function run(
  behavior: ExecBehavior,
  { timeoutMs = 0, argv = ["true"] }: { timeoutMs?: number; argv?: readonly string[] } = {},
): { client: FakeExecClient; result: Promise<unknown> } {
  const client = new FakeExecClient(behavior);
  const result = new ExecBuffer({ ref, argv, timeoutMs }).run(client, "the-command");
  return { client, result };
}

describe("ExecBuffer.run", () => {
  it("shell-quotes nothing — it runs the command string it is handed", async () => {
    const { client, result } = run({ code: 0 });
    await result;
    expect(client.commands).toEqual(["the-command"]);
  });

  it("captures stdout, stderr, and a zero exit code", async () => {
    const { result } = run({ stdout: "hello\n", stderr: "note\n", code: 0 });
    expect(await result).toEqual({ stdout: "hello\n", stderr: "note\n", code: 0, signal: null });
  });

  it("reports a non-zero exit code without rejecting", async () => {
    const { result } = run({ code: 3, stderr: "nope" });
    expect(await result).toMatchObject({ code: 3, stderr: "nope", signal: null });
  });

  it("normalises a signal kill to code null + signal name", async () => {
    const { result } = run({ signal: "SIGKILL" });
    expect(await result).toMatchObject({ code: null, signal: "SIGKILL" });
  });

  it("rejects with SshUnreachableError (carrying the cause) when the exec request fails", async () => {
    const boom = new Error("channel open failure");
    const { client, result } = run({ err: boom });

    const error = await result.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshUnreachableError);
    expect(error).toMatchObject({ retriable: true });
    if (error instanceof SshUnreachableError) expect(error.cause).toBe(boom);
    // No channel work happened — the request never opened one.
    expect(client.channels[0]?.destroyed).toBe(false);
  });

  it("rejects with SshUnreachableError when the channel closes without an exit status", async () => {
    // A mid-command drop: bytes arrive, then `close` with no `exit`. Must not be
    // mistaken for a clean signal-kill (`code: null`).
    const { result } = run({ stdout: "partial", closeWithoutExit: true });

    const error = await result.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshUnreachableError);
    expect(error).toMatchObject({ retriable: true });
  });

  it("aborts and rejects with SshExecTimeoutError when the command hangs, destroying the channel", async () => {
    const { client, result } = run({ hang: true }, { timeoutMs: 10, argv: ["sleep", "100"] });

    const error = await result.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SshExecTimeoutError);
    expect(error).toMatchObject({ retriable: true, timeoutMs: 10, argv: ["sleep", "100"] });
    expect(client.channels[0]?.destroyed).toBe(true);
  });

  it("does not arm a timeout when timeoutMs is 0 (a normal command still resolves)", async () => {
    const { result } = run({ stdout: "ok", code: 0 }, { timeoutMs: 0 });
    expect(await result).toMatchObject({ stdout: "ok", code: 0 });
  });
});
