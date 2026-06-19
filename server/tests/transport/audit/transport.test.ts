/**
 * Unit tests for {@link AuditingTransport}.
 *
 * A fake inner transport (recording calls, returning canned results or throwing
 * from the SSH error taxonomy) and a capturing fake sink let these assert that
 * every command records exactly one entry with the right outcome/exit-status,
 * that results and errors pass through unchanged, that context attribution
 * merges, and that argv is redacted — without opening a socket.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SshCommandError,
  SshExecTimeoutError,
  SshParseError,
  SshUnreachableError,
} from "../../../src/transport/ssh/errors.js";
import type { ExecOptions, ExecResult, SshTarget } from "../../../src/transport/ssh/facade.js";
import type { AuditEntry, AuditSink } from "../../../src/transport/audit/recorder.js";
import {
  AuditingTransport,
  type AuditableTransport,
} from "../../../src/transport/audit/transport.js";

const TARGET: SshTarget = { host: "client.local", username: "pct-agent", privateKey: "KEY" };
const TARGET_REF = { host: "client.local", port: 22, username: "pct-agent" };
const OK: ExecResult = { stdout: "out", stderr: "", code: 0, signal: null };

/** Captures recorded entries. */
class CapturingSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

interface RecordedCall {
  target: SshTarget;
  argv: readonly string[];
  options: ExecOptions | undefined;
}

/** A configurable inner transport. Each method returns a canned value or throws. */
class FakeInner implements AuditableTransport {
  readonly calls: RecordedCall[] = [];
  execResult: ExecResult = OK;
  execError: unknown;
  checkedResult: ExecResult = OK;
  checkedError: unknown;
  parsedValue: unknown = { ok: true };
  parsedError: unknown;

  async exec(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ target, argv, options });
    if (this.execError !== undefined) throw this.execError;
    return this.execResult;
  }

  async execChecked(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ target, argv, options });
    if (this.checkedError !== undefined) throw this.checkedError;
    return this.checkedResult;
  }

  async execAndParse<T>(
    target: SshTarget,
    argv: readonly string[],
    _schema: z.ZodType<T>,
    options?: ExecOptions,
  ): Promise<T> {
    this.calls.push({ target, argv, options });
    if (this.parsedError !== undefined) throw this.parsedError;
    return this.parsedValue as T;
  }
}

function setup(): { inner: FakeInner; sink: CapturingSink; transport: AuditingTransport } {
  const inner = new FakeInner();
  const sink = new CapturingSink();
  return { inner, sink, transport: new AuditingTransport(inner, sink) };
}

describe("AuditingTransport.execChecked", () => {
  it("records a single 'ok' entry and returns the result unchanged", async () => {
    const { inner, sink, transport } = setup();
    inner.checkedResult = { stdout: "x", stderr: "", code: 0, signal: null };

    const result = await transport.execChecked(TARGET, ["sudo", "timekpra", "--setlimit", "alice"]);

    expect(result).toBe(inner.checkedResult);
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({
      target: TARGET_REF,
      command: ["sudo", "timekpra", "--setlimit", "alice"],
      outcome: "ok",
      exitCode: 0,
      signal: null,
      errorMessage: null,
      context: {},
    });
    expect(sink.entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records 'failed' with exit code/signal and re-throws SshCommandError", async () => {
    const { inner, sink, transport } = setup();
    inner.checkedError = new SshCommandError(TARGET_REF, ["sudo", "timekpra", "x"], {
      code: 3,
      signal: null,
      stdout: "",
      stderr: "boom",
    });

    await expect(transport.execChecked(TARGET, ["sudo", "timekpra", "x"])).rejects.toBe(
      inner.checkedError,
    );
    expect(sink.entries[0]).toMatchObject({ outcome: "failed", exitCode: 3, signal: null });
    expect(sink.entries[0]?.errorMessage).toContain("Remote command failed");
  });

  it("records 'unreachable' for an SshUnreachableError", async () => {
    const { inner, sink, transport } = setup();
    inner.checkedError = new SshUnreachableError(TARGET_REF);
    await expect(transport.execChecked(TARGET, ["x"])).rejects.toBeInstanceOf(SshUnreachableError);
    expect(sink.entries[0]).toMatchObject({ outcome: "unreachable", exitCode: null, signal: null });
  });

  it("records 'timeout' for an SshExecTimeoutError", async () => {
    const { inner, sink, transport } = setup();
    inner.checkedError = new SshExecTimeoutError(TARGET_REF, ["x"], 30000);
    await expect(transport.execChecked(TARGET, ["x"])).rejects.toBeInstanceOf(SshExecTimeoutError);
    expect(sink.entries[0]?.outcome).toBe("timeout");
  });

  it("records 'failed' for an unexpected non-SSH rejection", async () => {
    const { inner, sink, transport } = setup();
    inner.checkedError = new Error("kaboom");
    await expect(transport.execChecked(TARGET, ["x"])).rejects.toThrow("kaboom");
    expect(sink.entries[0]).toMatchObject({ outcome: "failed", errorMessage: "kaboom" });
  });

  it("records 'failed' for a non-Error rejection (stringified)", async () => {
    const { inner, sink, transport } = setup();
    inner.checkedError = "weird";
    await expect(transport.execChecked(TARGET, ["x"])).rejects.toBe("weird");
    expect(sink.entries[0]).toMatchObject({ outcome: "failed", errorMessage: "weird" });
  });
});

describe("AuditingTransport.exec", () => {
  it("records 'ok' for a zero exit", async () => {
    const { inner, sink, transport } = setup();
    inner.execResult = { stdout: "", stderr: "", code: 0, signal: null };
    const result = await transport.exec(TARGET, ["whoami"]);
    expect(result).toBe(inner.execResult);
    expect(sink.entries[0]).toMatchObject({ outcome: "ok", exitCode: 0 });
  });

  it("records 'failed' for a non-zero exit (exec does not throw)", async () => {
    const { inner, sink, transport } = setup();
    inner.execResult = { stdout: "", stderr: "no", code: 1, signal: null };
    const result = await transport.exec(TARGET, ["false"]);
    expect(result.code).toBe(1);
    expect(sink.entries[0]).toMatchObject({ outcome: "failed", exitCode: 1, errorMessage: null });
  });

  it("forwards exec options to the inner transport", async () => {
    const { inner, transport } = setup();
    await transport.exec(TARGET, ["x"], { timeoutMs: 5000 });
    expect(inner.calls[0]?.options).toEqual({ timeoutMs: 5000 });
  });
});

describe("AuditingTransport.execAndParse", () => {
  const schema = z.object({ ok: z.boolean() });

  it("records 'ok' (exit 0) and returns the parsed value", async () => {
    const { inner, sink, transport } = setup();
    inner.parsedValue = { ok: true };
    const value = await transport.execAndParse(TARGET, ["sudo", "timekpra", "--userinfo"], schema);
    expect(value).toEqual({ ok: true });
    expect(sink.entries[0]).toMatchObject({ outcome: "ok", exitCode: 0, signal: null });
  });

  it("records 'parse_error' and re-throws SshParseError", async () => {
    const { inner, sink, transport } = setup();
    inner.parsedError = new SshParseError(TARGET_REF, ["sudo", "timekpra", "--userinfo"], "junk");
    await expect(
      transport.execAndParse(TARGET, ["sudo", "timekpra", "--userinfo"], schema),
    ).rejects.toBeInstanceOf(SshParseError);
    expect(sink.entries[0]?.outcome).toBe("parse_error");
  });
});

describe("AuditingTransport context + redaction", () => {
  it("withContext merges attribution into recorded entries", async () => {
    const { sink, transport } = setup();
    const bound = transport.withContext({ clientId: 5, userId: 9, actor: "admin" });
    await bound.execChecked(TARGET, ["x"]);
    expect(sink.entries[0]?.context).toEqual({ clientId: 5, userId: 9, actor: "admin" });
  });

  it("withContext overlays on an existing context without losing prior fields", async () => {
    const inner = new FakeInner();
    const sink = new CapturingSink();
    const base = new AuditingTransport(inner, sink, { clientId: 1, actor: "system" });
    const refined = base.withContext({ userId: 2, actor: "admin" });
    await refined.execChecked(TARGET, ["x"]);
    expect(sink.entries[0]?.context).toEqual({ clientId: 1, userId: 2, actor: "admin" });
  });

  it("redacts secret-bearing arguments before recording", async () => {
    const { sink, transport } = setup();
    await transport.execChecked(TARGET, ["tool", "--token", "supersecret"]);
    expect(sink.entries[0]?.command).toEqual(["tool", "--token", "[redacted]"]);
  });

  it("defaults the recorded port to 22 and uses an explicit port when given", async () => {
    const { sink, transport } = setup();
    await transport.execChecked({ ...TARGET, port: 2222 }, ["x"]);
    expect(sink.entries[0]?.target).toEqual({ ...TARGET_REF, port: 2222 });
  });
});
