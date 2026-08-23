/**
 * Unit tests for the post-enrol connectivity verifier (#354).
 *
 * The verifier is a thin classified wrapper over a single `true` exec: a run
 * that resolves is reachable; the SSH error taxonomy (#353) maps to a
 * `failureClass`. These tests drive it with a structural fake transport (no live
 * SSH), asserting the argv/target it issues, the reachable/offline outcomes, the
 * per-class mapping, the injectable clock, the one-warn-per-failure log line,
 * and that a non-`SshError` surfaces rather than masquerading as offline.
 */
import { describe, expect, it, vi } from "vitest";

import {
  SshExecTimeoutError,
  SshParseError,
  SshUnreachableError,
  type SshTargetRef,
} from "../../../src/transport/ssh/errors.js";
import type { ExecOptions, ExecResult, SshTarget } from "../../../src/transport/ssh/facade.js";
import {
  SshClientConnectionVerifier,
  type VerifyLogger,
  type VerifyTransport,
} from "../../../src/transport/health/index.js";

const CREDENTIALS = { privateKey: "fake-private-key" };
const CLIENT = { id: 7, hostname: "alice-pc.local", sshUser: "pct-agent" } as const;
const AT = new Date("2026-08-23T10:00:00.000Z");
const REF: SshTargetRef = { host: "alice-pc.local", port: 22, username: "pct-agent" };

/** A fake transport whose `exec` resolves (ok) or rejects with a supplied error. */
function fakeTransport(behaviour: () => Promise<ExecResult>): {
  transport: VerifyTransport;
  calls: { target: SshTarget; argv: readonly string[]; options?: ExecOptions }[];
} {
  const calls: { target: SshTarget; argv: readonly string[]; options?: ExecOptions }[] = [];
  return {
    calls,
    transport: {
      exec: (target, argv, options) => {
        calls.push({ target, argv, ...(options !== undefined ? { options } : {}) });
        return behaviour();
      },
    },
  };
}

const okResult: ExecResult = { stdout: "", stderr: "", code: 0, signal: null };

describe("SshClientConnectionVerifier", () => {
  it("reports reachable and issues a single `true` over the client's target", async () => {
    const fake = fakeTransport(() => Promise.resolve(okResult));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
    });

    const result = await verifier.verify(CLIENT);

    expect(result).toEqual({
      reachable: true,
      reason: null,
      detail: "SSH round-trip succeeded",
      at: AT,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.argv).toEqual(["true"]);
    expect(fake.calls[0]?.target).toMatchObject({
      host: "alice-pc.local",
      username: "pct-agent",
      privateKey: "fake-private-key",
    });
  });

  it("forwards the configured execOptions to the transport", async () => {
    const fake = fakeTransport(() => Promise.resolve(okResult));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
      execOptions: { timeoutMs: 5000 },
    });

    await verifier.verify(CLIENT);

    expect(fake.calls[0]?.options).toEqual({ timeoutMs: 5000 });
  });

  it.each([
    ["dns", { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND alice-pc.local" }],
    ["connection_refused", { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }],
    ["timeout", { code: "ETIMEDOUT", message: "connect ETIMEDOUT" }],
    [
      "auth",
      { level: "client-authentication", message: "All configured authentication methods failed" },
    ],
    ["handshake", { level: "protocol", message: "Handshake failed: key exchange" }],
  ])("maps an unreachable %s failure to its class", async (expected, cause) => {
    const fake = fakeTransport(() => Promise.reject(new SshUnreachableError(REF, { cause })));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
    });

    const result = await verifier.verify(CLIENT);

    expect(result.reachable).toBe(false);
    expect(result.reason).toBe(expected);
    expect(result.at).toBe(AT);
    expect(result.detail).toContain(expected);
  });

  it("maps an unreachable error with no cause to `unknown`", async () => {
    const fake = fakeTransport(() => Promise.reject(new SshUnreachableError(REF)));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
    });

    const result = await verifier.verify(CLIENT);

    expect(result).toMatchObject({ reachable: false, reason: "unknown" });
  });

  it("maps an exec timeout (the box answered but `true` hung) to `timeout`", async () => {
    const fake = fakeTransport(() => Promise.reject(new SshExecTimeoutError(REF, ["true"], 5000)));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
    });

    const result = await verifier.verify(CLIENT);

    expect(result).toMatchObject({ reachable: false, reason: "timeout" });
  });

  it("degrades any other SshError to `unknown` rather than throwing", async () => {
    const fake = fakeTransport(() => Promise.reject(new SshParseError(REF, ["true"], "garbage")));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
    });

    const result = await verifier.verify(CLIENT);

    expect(result).toMatchObject({ reachable: false, reason: "unknown" });
  });

  it("rethrows a non-SshError (a real bug is never masqueraded as offline)", async () => {
    const bug = new TypeError("boom");
    const fake = fakeTransport(() => Promise.reject(bug));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
    });

    await expect(verifier.verify(CLIENT)).rejects.toBe(bug);
  });

  it("emits one structured warn per failed verification, with the classified reason", async () => {
    const warn = vi.fn();
    const log: VerifyLogger = { warn };
    const fake = fakeTransport(() =>
      Promise.reject(new SshUnreachableError(REF, { cause: { code: "ECONNREFUSED" } })),
    );
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
      log,
    });

    await verifier.verify(CLIENT);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      clientId: 7,
      host: "alice-pc.local",
      reason: "connection_refused",
    });
  });

  it("does not log on a successful verification", async () => {
    const warn = vi.fn();
    const fake = fakeTransport(() => Promise.resolve(okResult));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
      log: { warn },
    });

    await verifier.verify(CLIENT);

    expect(warn).not.toHaveBeenCalled();
  });

  it("omits clientId from the log line when the client row carries no id", async () => {
    const warn = vi.fn();
    const fake = fakeTransport(() => Promise.reject(new SshUnreachableError(REF)));
    const verifier = new SshClientConnectionVerifier(fake.transport, CREDENTIALS, {
      now: () => AT,
      log: { warn },
    });

    await verifier.verify({ hostname: "alice-pc.local", sshUser: "pct-agent" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("clientId");
  });
});
