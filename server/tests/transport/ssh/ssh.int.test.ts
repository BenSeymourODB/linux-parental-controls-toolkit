/**
 * Live integration test for the SSH transport facade (issue #157, deferred
 * from #82).
 *
 * Unlike `facade.test.ts` — which mocks `ssh2` and never opens a socket — this
 * exercises the real boundary: a key-authenticated `ssh2` handshake to a live
 * OpenSSH server, a real `exec` channel, real stdout/stderr/exit-code capture,
 * and the shell-quoting of an argv vector into the single command string SSH's
 * exec request carries. It confirms the facade's contract holds against an
 * actual server, not just a fake.
 *
 * Env-gated via {@link liveSshEnabled}: skipped unless the integration target
 * is configured (see `.github/workflows/integration.yml` → `ssh-transport`, or
 * `docs/testing.md`). The unit run never collects `*.int.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SshCommandError,
  SshParseError,
  SshUnreachableError,
} from "../../../src/transport/ssh/errors.js";
import type { SshTarget } from "../../../src/transport/ssh/facade.js";
import { SshTransport } from "../../../src/transport/ssh/facade.js";
import { liveSshEnabled, liveSshTarget, waitForSshReady } from "../../helpers/ssh-live.js";

describe.skipIf(!liveSshEnabled)("SshTransport against a live OpenSSH server", () => {
  const transport = new SshTransport({ readyTimeoutMs: 8000 });
  let target: SshTarget;

  beforeAll(async () => {
    target = liveSshTarget();
    await waitForSshReady(transport, target);
  }, 60_000);

  afterAll(() => {
    transport.disposeAll();
  });

  it("exec captures stdout and a zero exit code", async () => {
    const result = await transport.exec(target, ["/bin/echo", "hello"]);
    expect(result.stdout.trimEnd()).toBe("hello");
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("exec reports a non-zero exit code without throwing", async () => {
    const result = await transport.exec(target, ["/bin/sh", "-c", "exit 3"]);
    expect(result.code).toBe(3);
  });

  it("execChecked resolves on a zero exit", async () => {
    const result = await transport.execChecked(target, ["/bin/echo", "ok"]);
    expect(result.code).toBe(0);
  });

  it("execChecked rejects a non-zero exit with SshCommandError", async () => {
    await expect(transport.execChecked(target, ["/bin/sh", "-c", "exit 4"])).rejects.toBeInstanceOf(
      SshCommandError,
    );
  });

  it("delivers argv elements verbatim — the remote shell never reinterprets them", async () => {
    // Every shell metacharacter that single-quoting must neutralise, including
    // an embedded single quote (the one char single quotes can't contain).
    const tricky = "a b;c|d$e`f'g\"h(i)&&j>k";
    const result = await transport.exec(target, ["/bin/echo", tricky]);
    expect(result.stdout.trimEnd()).toBe(tricky);
  });

  it("execAndParse validates stdout and returns typed data", async () => {
    const schema = z.string().transform((raw) => raw.trim());
    const value = await transport.execAndParse(target, ["/bin/echo", "value"], schema);
    expect(value).toBe("value");
  });

  it("execAndParse rejects unparseable stdout with SshParseError", async () => {
    const numeric = z.string().transform((raw, ctx) => {
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) {
        ctx.addIssue({ code: "custom", message: "expected digits" });
        return z.NEVER;
      }
      return Number(trimmed);
    });
    await expect(
      transport.execAndParse(target, ["/bin/echo", "not-a-number"], numeric),
    ).rejects.toBeInstanceOf(SshParseError);
  });

  it("pools one connection per target and disposes it", async () => {
    const pooled = new SshTransport({ readyTimeoutMs: 8000 });
    try {
      await pooled.exec(target, ["/bin/echo", "1"]);
      await pooled.exec(target, ["/bin/echo", "2"]);
      expect(pooled.connectionCount).toBe(1);
      pooled.dispose(target);
      expect(pooled.connectionCount).toBe(0);
    } finally {
      pooled.disposeAll();
    }
  });

  it("rejects an unreachable host with SshUnreachableError", async () => {
    const unreachable: SshTarget = { ...target, port: 1 };
    const transient = new SshTransport({ readyTimeoutMs: 3000 });
    try {
      await expect(transient.exec(unreachable, ["/bin/echo", "x"])).rejects.toBeInstanceOf(
        SshUnreachableError,
      );
    } finally {
      transient.disposeAll();
    }
  });
});
