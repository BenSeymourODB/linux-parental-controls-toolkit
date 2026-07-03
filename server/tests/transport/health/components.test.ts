/**
 * Unit tests for the client-component catalogue and the `systemctl is-active`
 * classification (#81). The catalogue is the single source of *what* the prober
 * walks and *how*, and `classifyServiceState` is the pure verdict the prober
 * applies to each system-service probe's stdout.
 */
import { describe, expect, it } from "vitest";

import {
  activityWatchFailureDetail,
  AW_SERVER_PORT,
  CLIENT_COMPONENTS,
  classifyActivityWatchInfo,
  classifyServiceState,
  clientComponentValues,
  componentHealthStatusValues,
  systemdIsActiveArgv,
} from "../../../src/transport/health/components.js";
import {
  ActivityWatchParseError,
  ActivityWatchRequestError,
  ActivityWatchUnreachableError,
} from "../../../src/transport/activitywatch/errors.js";
import type { AwServerInfo } from "../../../src/transport/activitywatch/schemas.js";

describe("client component catalogue", () => {
  it("has one descriptor per declared component, in enum order", () => {
    expect(CLIENT_COMPONENTS.map((d) => d.component)).toEqual([...clientComponentValues]);
  });

  it("probes the system services with `systemctl is-active <unit>` (no privilege)", () => {
    const system = CLIENT_COMPONENTS.filter((d) => d.probe.method === "systemd-system");
    expect(system.map((d) => d.component)).toEqual([
      "timekpr-next",
      "e2guardian",
      "pct-client-bridge",
    ]);
    for (const descriptor of system) {
      if (descriptor.probe.method !== "systemd-system") throw new Error("unreachable");
      expect(systemdIsActiveArgv(descriptor.probe.unit)).toEqual([
        "systemctl",
        "is-active",
        descriptor.probe.unit,
      ]);
      // No `sudo` — `is-active` is a read-only query the `pct-agent` can run.
      expect(systemdIsActiveArgv(descriptor.probe.unit)[0]).toBe("systemctl");
    }
  });

  it("probes ActivityWatch over a REST forward to the loopback aw-server port", () => {
    const aw = CLIENT_COMPONENTS.find((d) => d.component === "activitywatch");
    expect(aw?.probe.method).toBe("activitywatch-rest");
    if (aw?.probe.method !== "activitywatch-rest") throw new Error("unreachable");
    expect(aw.probe.port).toBe(AW_SERVER_PORT);
    expect(AW_SERVER_PORT).toBe(5600);
  });

  it("still defers the per-user pct-client-agent with a reason, not a guessed probe", () => {
    const deferred = CLIENT_COMPONENTS.filter((d) => d.probe.method === "deferred");
    expect(deferred.map((d) => d.component)).toEqual(["pct-client-agent"]);
    for (const descriptor of deferred) {
      if (descriptor.probe.method !== "deferred") throw new Error("unreachable");
      expect(descriptor.probe.detail).toMatch(/per-user/);
    }
  });
});

describe("classifyActivityWatchInfo", () => {
  it("reports ok with the aw-server version in the detail", () => {
    const info: AwServerInfo = { hostname: "alice-pc", version: "v0.13.2", testing: false };
    expect(classifyActivityWatchInfo(info)).toEqual({ status: "ok", detail: "aw-server v0.13.2" });
  });
});

describe("activityWatchFailureDetail", () => {
  const BASE = "http://127.0.0.1:5600";

  it("maps a connection failure to `not responding`", () => {
    const detail = activityWatchFailureDetail(
      new ActivityWatchUnreachableError(BASE, "/api/0/info", new Error("ECONNREFUSED"), false),
    );
    expect(detail).toBe("aw-server not responding");
  });

  it("distinguishes a per-request timeout", () => {
    const detail = activityWatchFailureDetail(
      new ActivityWatchUnreachableError(BASE, "/api/0/info", new Error("aborted"), true),
    );
    expect(detail).toBe("aw-server did not respond in time");
  });

  it("carries the HTTP status for a non-2xx answer", () => {
    const detail = activityWatchFailureDetail(
      new ActivityWatchRequestError(BASE, "/api/0/info", 503, "Service Unavailable"),
    );
    expect(detail).toBe("aw-server returned HTTP 503");
  });

  it("reports an unrecognised body distinctly", () => {
    const detail = activityWatchFailureDetail(
      new ActivityWatchParseError(BASE, "/api/0/info", "not json"),
    );
    expect(detail).toBe("aw-server sent an unrecognised response");
  });

  it("returns undefined for a non-ActivityWatch error so the prober rethrows it", () => {
    expect(activityWatchFailureDetail(new Error("boom"))).toBeUndefined();
    expect(activityWatchFailureDetail(undefined)).toBeUndefined();
  });
});

describe("classifyServiceState", () => {
  it("treats only `active` as healthy", () => {
    expect(classifyServiceState("active")).toEqual({ status: "ok", detail: "active" });
    expect(classifyServiceState("active\n")).toEqual({ status: "ok", detail: "active" });
  });

  it.each(["inactive", "failed", "activating", "deactivating", "reloading"])(
    "maps non-active state %s to unhealthy with the state as detail",
    (state) => {
      expect(classifyServiceState(`${state}\n`)).toEqual({ status: "unhealthy", detail: state });
    },
  );

  it("reports unknown when systemd emits nothing", () => {
    expect(classifyServiceState("")).toEqual({ status: "unknown", detail: "no state reported" });
    expect(classifyServiceState("   \n")).toEqual({
      status: "unknown",
      detail: "no state reported",
    });
  });

  it("reads only the first line (is-active prints one word)", () => {
    expect(classifyServiceState("active\nstuff after")).toEqual({ status: "ok", detail: "active" });
  });

  it("declares the status vocabulary the DTO derives from", () => {
    expect(componentHealthStatusValues).toEqual(["ok", "unhealthy", "unknown"]);
  });
});
