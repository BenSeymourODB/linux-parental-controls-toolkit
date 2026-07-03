/**
 * Unit tests for {@link SshClientProber}.
 *
 * The SSH transport is a lightweight in-memory fake implementing the
 * {@link HealthProbeTransport} structural interface — it records the argv it is
 * handed and returns canned `systemctl is-active` output (or throws the facade's
 * error taxonomy), and its `withPortForward` runs the callback against a canned
 * loopback endpoint. The ActivityWatch REST probe is injected as a function so
 * these tests assert reachability + per-component classification (including the
 * `activitywatch` verdict) without opening a socket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ActivityWatchParseError,
  ActivityWatchRequestError,
  ActivityWatchUnreachableError,
} from "../../../src/transport/activitywatch/errors.js";
import type { AwServerInfo } from "../../../src/transport/activitywatch/schemas.js";
import {
  SshExecTimeoutError,
  SshUnreachableError,
  SshCommandError,
} from "../../../src/transport/ssh/errors.js";
import type {
  ExecOptions,
  ExecResult,
  PortForwardTarget,
  SshCredentials,
  SshTarget,
} from "../../../src/transport/ssh/facade.js";
import {
  SshClientProber,
  type ActivityWatchInfoProbe,
  type HealthProbeTransport,
} from "../../../src/transport/health/prober.js";

const CREDENTIALS: SshCredentials = { privateKey: "PRIVATE-KEY", port: 2222 };
const CLIENT = { hostname: "alice-pc.local", sshUser: "pct-agent" };
const HEALTHY_INFO: AwServerInfo = { hostname: "alice-pc", version: "v0.13.2", testing: false };
/** The loopback endpoint the fake's `withPortForward` hands its callback. */
const FORWARDED_BASE_URL = "http://127.0.0.1:54321";

interface RecordedCall {
  target: SshTarget;
  argv: readonly string[];
  options: ExecOptions | undefined;
}

interface RecordedForward {
  target: SshTarget;
  remote: PortForwardTarget;
}

const active = (): ExecResult => ({ stdout: "active\n", stderr: "", code: 0, signal: null });
const inactive = (): ExecResult => ({ stdout: "inactive\n", stderr: "", code: 3, signal: null });

/**
 * A fake transport: canned per-unit `exec` output (or a thrown error), and a
 * `withPortForward` that runs its callback against {@link FORWARDED_BASE_URL}
 * (or throws {@link throwOnPortForward} to simulate the tunnel failing to open).
 */
class FakeProbeTransport implements HealthProbeTransport {
  readonly calls: RecordedCall[] = [];
  readonly forwards: RecordedForward[] = [];
  readonly responses = new Map<string, ExecResult>();
  throwOnEveryExec: Error | undefined;
  throwForUnit: { unit: string; error: Error } | undefined;
  throwOnPortForward: Error | undefined;

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

  async withPortForward<T>(
    target: SshTarget,
    remote: PortForwardTarget,
    fn: (local: { host: string; port: number }) => Promise<T>,
  ): Promise<T> {
    this.forwards.push({ target, remote });
    if (this.throwOnPortForward !== undefined) throw this.throwOnPortForward;
    return fn({ host: "127.0.0.1", port: 54321 });
  }
}

let transport: FakeProbeTransport;

beforeEach(() => {
  transport = new FakeProbeTransport();
});

const FIXED = new Date("2026-06-19T12:00:00.000Z");

/** Prober with fixed clock, tight timeout, and a healthy AW probe by default. */
function proberWith(
  probeActivityWatch: ActivityWatchInfoProbe = async () => HEALTHY_INFO,
): SshClientProber {
  return new SshClientProber(transport, CREDENTIALS, {
    execOptions: { timeoutMs: 5000 },
    now: () => FIXED,
    probeActivityWatch,
  });
}

const awComponent = (result: { components: readonly { component: string }[] }): unknown =>
  result.components.find((c) => c.component === "activitywatch");

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
    expect(result.reachabilityReason).toBeNull();
    expect(result.at).toBe(FIXED);
    expect(result.components).toEqual([
      { component: "timekpr-next", status: "ok", detail: "active" },
      { component: "activitywatch", status: "ok", detail: "aw-server v0.13.2" },
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

  it("probes aw-server over a loopback forward to port 5600 and reports its version", async () => {
    let seenBaseUrl: string | undefined;
    const result = await proberWith(async (baseUrl) => {
      seenBaseUrl = baseUrl;
      return HEALTHY_INFO;
    }).probe(CLIENT);

    expect(result.reachability).toBe("online");
    expect(awComponent(result)).toEqual({
      component: "activitywatch",
      status: "ok",
      detail: "aw-server v0.13.2",
    });
    // Forwarded once, to the loopback aw-server port, with the resolved target.
    expect(transport.forwards).toEqual([
      {
        target: {
          host: "alice-pc.local",
          username: "pct-agent",
          privateKey: "PRIVATE-KEY",
          port: 2222,
        },
        remote: { port: 5600 },
      },
    ]);
    expect(seenBaseUrl).toBe(FORWARDED_BASE_URL);
  });

  it("reports activitywatch unhealthy when the tunnel opens but aw-server doesn't answer", async () => {
    const result = await proberWith(async () => {
      throw new ActivityWatchUnreachableError(
        FORWARDED_BASE_URL,
        "/api/0/info",
        new Error("ECONNREFUSED"),
        false,
      );
    }).probe(CLIENT);

    // The host is reachable (SSH is fine); only AW is down.
    expect(result.reachability).toBe("online");
    expect(awComponent(result)).toEqual({
      component: "activitywatch",
      status: "unhealthy",
      detail: "aw-server not responding",
    });
  });

  it.each([
    [
      "a non-2xx answer",
      new ActivityWatchRequestError(FORWARDED_BASE_URL, "/api/0/info", 503, "Service Unavailable"),
      "aw-server returned HTTP 503",
    ],
    [
      "an unparseable body",
      new ActivityWatchParseError(FORWARDED_BASE_URL, "/api/0/info", "not json"),
      "aw-server sent an unrecognised response",
    ],
  ])("classifies %s as unhealthy without going offline", async (_label, error, detail) => {
    const result = await proberWith(async () => {
      throw error;
    }).probe(CLIENT);
    expect(result.reachability).toBe("online");
    expect(awComponent(result)).toEqual({
      component: "activitywatch",
      status: "unhealthy",
      detail,
    });
  });

  it("goes offline (all unknown) when the aw-server tunnel itself fails to open", async () => {
    transport.throwOnPortForward = new SshUnreachableError({
      host: CLIENT.hostname,
      port: 2222,
      username: CLIENT.sshUser,
    });

    const result = await proberWith().probe(CLIENT);

    expect(result.reachability).toBe("offline");
    expect(result.reachabilityReason).toBe("unknown");
    expect(result.components).toHaveLength(5);
    expect(result.components.every((c) => c.status === "unknown")).toBe(true);
    // The classified cause is folded into the detail (#353); no ssh2 cause on
    // this fixture, so the reason is `unknown`.
    expect(result.components.every((c) => c.detail === "host unreachable (unknown)")).toBe(true);
  });

  it("rethrows an unexpected (non-SSH, non-AW) error from the aw probe", async () => {
    await expect(
      proberWith(async () => {
        throw new Error("aw boom");
      }).probe(CLIENT),
    ).rejects.toThrow("aw boom");
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
    // With no ssh2 cause the reason is `unknown`, surfaced in the detail (#353).
    expect(result.reachabilityReason).toBe("unknown");
    expect(result.components.every((c) => c.detail === "host unreachable (unknown)")).toBe(true);
  });

  it("classifies the failure cause and folds it into the reason + detail (#353)", async () => {
    transport.throwOnEveryExec = new SshUnreachableError(
      { host: CLIENT.hostname, port: 2222, username: CLIENT.sshUser },
      {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND alice-pc.local"), {
          code: "ENOTFOUND",
        }),
      },
    );

    const result = await proberWith().probe(CLIENT);

    expect(result.reachability).toBe("offline");
    expect(result.reachabilityReason).toBe("dns");
    expect(result.components[0]?.detail).toBe(
      "host unreachable (dns: getaddrinfo ENOTFOUND alice-pc.local)",
    );
  });

  it("logs one structured warn per failed probe, including clientId when present", async () => {
    transport.throwOnEveryExec = new SshUnreachableError(
      { host: CLIENT.hostname, port: 2222, username: CLIENT.sshUser },
      { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) },
    );
    const warn = vi.fn();
    const prober = new SshClientProber(transport, CREDENTIALS, {
      execOptions: { timeoutMs: 5000 },
      now: () => FIXED,
      log: { warn },
    });

    await prober.probe({ ...CLIENT, id: 7 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 7,
        host: CLIENT.hostname,
        port: 2222,
        reason: "connection_refused",
        cause: "connect ECONNREFUSED",
      }),
      expect.any(String),
    );
  });

  it("omits clientId from the log when the probed client has none", async () => {
    transport.throwOnEveryExec = new SshUnreachableError({
      host: CLIENT.hostname,
      port: 2222,
      username: CLIENT.sshUser,
    });
    const warn = vi.fn();
    const prober = new SshClientProber(transport, CREDENTIALS, { now: () => FIXED, log: { warn } });

    await prober.probe(CLIENT);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("clientId");
  });

  it("treats a per-exec timeout as offline with a timeout reason", async () => {
    transport.throwOnEveryExec = new SshExecTimeoutError(
      { host: CLIENT.hostname, port: 2222, username: CLIENT.sshUser },
      ["systemctl", "is-active", "timekpr.service"],
      5000,
    );

    const result = await proberWith().probe(CLIENT);
    expect(result.reachability).toBe("offline");
    expect(result.reachabilityReason).toBe("timeout");
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
    expect(result.reachabilityReason).toBe("unknown");
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
    const result = await new SshClientProber(transport, CREDENTIALS, {
      probeActivityWatch: async () => HEALTHY_INFO,
    }).probe(CLIENT);
    expect(result.at.getTime()).toBeGreaterThanOrEqual(before);
  });
});
