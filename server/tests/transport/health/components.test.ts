/**
 * Unit tests for the client-component catalogue and the `systemctl is-active`
 * classification (#81). The catalogue is the single source of *what* the prober
 * walks and *how*, and `classifyServiceState` is the pure verdict the prober
 * applies to each system-service probe's stdout.
 */
import { describe, expect, it } from "vitest";

import {
  CLIENT_COMPONENTS,
  classifyServiceState,
  clientComponentValues,
  componentHealthStatusValues,
  systemdIsActiveArgv,
} from "../../../src/transport/health/components.js";

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

  it("defers the per-user components with a reason, not a guessed probe", () => {
    const deferred = CLIENT_COMPONENTS.filter((d) => d.probe.method === "deferred");
    expect(deferred.map((d) => d.component)).toEqual(["activitywatch", "pct-client-agent"]);
    for (const descriptor of deferred) {
      if (descriptor.probe.method !== "deferred") throw new Error("unreachable");
      expect(descriptor.probe.detail).toMatch(/per-user/);
    }
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
