/**
 * Unit tests for {@link SshClientProber}.
 *
 * The SSH transport is a lightweight in-memory fake implementing the
 * {@link HealthProbeTransport} structural interface — it records the argv it is
 * handed and returns canned `systemctl is-active` output (or throws the facade's
 * error taxonomy), so these tests assert reachability + per-component
 * classification without opening a socket.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  SshExecTimeoutError,
  SshUnreachableError,
  SshCommandError,
} from "../../../src/transport/ssh/errors.js";
import type {
  ExecOptions,
  ExecResult,
  SshCredentials,
  SshTarget,
} from "../../../src/transport/ssh/facade.js";
import {
  SshClientProber,
  type HealthProbeTransport,
} from "../../../src/transport/health/prober.js";

const CREDENTIALS: SshCredentials = { privateKey: "PRIVATE-KEY", port: 2222 };
const CLIENT = { hostname: "alice-pc.local", sshUser: "pct-agent" };

interface RecordedCall {
  target: SshTarget;
  argv: readonly string[];
  options: ExecOptions | undefined;
}

const active = (): ExecResult => ({ stdout: "active\n", stderr: "", code: 0, signal: null });
const inactive = (): ExecResult => ({ stdout: "inactive\n", stderr: "", code: 3, signal: null });

/** A fake transport: canned per-unit output, or an error thrown on exec. */
class FakeProbeTransport implements HealthProbeTransport {
  readonly calls: RecordedCall[] = [];
  readonly responses = new Map<string, ExecResult>();
  throwOnEveryExec: Error | undefined;
  throwForUnit: { unit: string; error: Error } | undefined;

  async exec(
    target: SshTarget,
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ target, argv, options });
    const unit = argv[2] ?? "";
    if (this.throwOnEveryExec !== undefined) throw this.throwOnEveryExec;
    if (this.throwForUnit !== undefined && this.throwForUnit.unit === unit) {
      throw this.throwForUnit.error;
    }
    return this.responses.get(unit) ?? active();
  }
}

let transport: FakeProbeTransport;

beforeEach(() => {
  transport = new FakeProbeTransport();
});

const FIXED = new Date("2026-06-19T12:00:00.000Z");

function proberWith(): SshClientProber {
  return new SshClientProber(transport, CREDENTIALS, {
    execOptions: { timeoutMs: 5000 },
    now: () => FIXED,
  });
}

describe("SshClientProber.probe", () => {
  it("reports online with per-component verdicts and resolves the target from credentials", async () => {
    transport.responses.set("e2guardian.service", inactive());
    transport.responses.set("pct-client-bridge.service", {
      stdout: "failed\n",
      stderr: "",
      code: 3,
      signal: null,
    });

    const result = await proberWith().probe(CLIENT);

    expect(result.reachability).toBe("online");
    expect(result.at).toBe(FIXED);
    expect(result.components).toEqual([
      { component: "timekpr-next", status: "ok", detail: "active" },
      {
        component: "activitywatch",
        status: "unknown",
        detail: "per-user aw-server probe lands with Phase 5 (#86)",
      },
      { component: "e2guardian", status: "unhealthy", detail: "inactive" },
      { component: "pct-client-bridge", status: "unhealthy", detail: "failed" },
      {
        component: "pct-client-agent",
        status: "unknown",
        detail: "per-user systemd --user probe lands with Phase 8b (#103)",
      },
    ]);

    // Only the three system services are execed; target + options are threaded.
    expect(transport.calls.map((c) => c.argv)).toEqual([
      ["systemctl", "is-active", "timekpr.service"],
      ["systemctl", "is-active", "e2guardian.service"],
      ["systemctl", "is-active", "pct-client-bridge.service"],
    ]);
    expect(transport.calls[0]?.target).toEqual({
      host: "alice-pc.local",
      username: "pct-agent",
      privateKey: "PRIVATE-KEY",
      port: 2222,
    });
    expect(transport.calls[0]?.options).toEqual({ timeoutMs: 5000 });
  });

  it("reports offline with all components unknown when the host is unreachable", async () => {
    transport.throwOnEveryExec = new SshUnreachableError({
      host: CLIENT.hostname,
      port: 2222,
      username: CLIENT.sshUser,
    });

    const result = await proberWith().probe(CLIENT);

    expect(result.reachability).toBe("offline");
    expect(result.at).toBe(FIXED);
    expect(result.components).toHaveLength(5);
    expect(result.components.every((c) => c.status === "unknown")).toBe(true);
    expect(result.components.every((c) => c.detail === "host unreachable")).toBe(true);
  });

  it("treats a per-exec timeout as offline", async () => {
    transport.throwOnEveryExec = new SshExecTimeoutError(
      { host: CLIENT.hostname, port: 2222, username: CLIENT.sshUser },
      ["systemctl", "is-active", "timekpr.service"],
      5000,
    );

    const result = await proberWith().probe(CLIENT);
    expect(result.reachability).toBe("offline");
  });

  it("goes offline if the host drops mid-probe (after some components succeeded)", async () => {
    transport.throwForUnit = {
      unit: "e2guardian.service",
      error: new SshUnreachableError({
        host: CLIENT.hostname,
        port: 2222,
        username: CLIENT.sshUser,
      }),
    };

    const result = await proberWith().probe(CLIENT);
    expect(result.reachability).toBe("offline");
    expect(result.components.every((c) => c.status === "unknown")).toBe(true);
  });

  it("treats a non-zero exit (SshCommandError) from a checked path defensively as offline", async () => {
    // The facade's unchecked exec never raises SshCommandError, but if any
    // SshError surfaces the prober must not crash — it reports the box offline.
    transport.throwOnEveryExec = new SshCommandError(
      { host: CLIENT.hostname, port: 2222, username: CLIENT.sshUser },
      ["systemctl", "is-active", "timekpr.service"],
      { code: 1, signal: null, stdout: "", stderr: "" },
    );
    const result = await proberWith().probe(CLIENT);
    expect(result.reachability).toBe("offline");
  });

  it("propagates an unexpected (non-SSH) error rather than masking it as offline", async () => {
    transport.throwOnEveryExec = new Error("boom");
    await expect(proberWith().probe(CLIENT)).rejects.toThrow("boom");
  });

  it("defaults the clock to wall time when no `now` is injected", async () => {
    const before = Date.now();
    const result = await new SshClientProber(transport, CREDENTIALS).probe(CLIENT);
    expect(result.at.getTime()).toBeGreaterThanOrEqual(before);
  });
});
