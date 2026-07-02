/**
 * Unit tests for the client version-drift classification (#352): the pure
 * `compareVersions` ordering and the `classifyVersionStatus` verdict the admin
 * Clients page badges on.
 */
import { describe, expect, it } from "vitest";

import { classifyVersionStatus, compareVersions } from "../../../src/api/clients/version-status.js";

describe("compareVersions", () => {
  it("orders by numeric release identifiers", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("treats missing release fields as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });

  it("sorts a prerelease before its final release (semver §11)", () => {
    expect(compareVersions("0.1.0-alpha.1", "0.1.0")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.0-alpha.1")).toBe(1);
  });

  it("orders prerelease tags: numeric numerically, and by length on a tie", () => {
    expect(compareVersions("0.1.0-alpha.2", "0.1.0-alpha.10")).toBe(-1);
    expect(compareVersions("0.1.0-alpha", "0.1.0-alpha.1")).toBe(-1);
    expect(compareVersions("0.1.0-alpha.5", "0.1.0-alpha.5")).toBe(0);
  });

  it("ranks numeric prerelease identifiers below alphanumeric ones", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("strips a leading v and treats Debian ~ as the prerelease separator", () => {
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    // The tilde form (dpkg) and the dash form (git tag) compare equal.
    expect(compareVersions("0.1.0~alpha.5", "0.1.0-alpha.5")).toBe(0);
    expect(compareVersions("0.1.0~alpha.4", "0.1.0-alpha.5")).toBe(-1);
  });

  it("returns null when either release component is unparseable", () => {
    expect(compareVersions("nightly", "0.1.0")).toBeNull();
    expect(compareVersions("0.1.0", "")).toBeNull();
    expect(compareVersions("1.x.0", "1.0.0")).toBeNull();
  });
});

describe("classifyVersionStatus", () => {
  it("returns update_required whenever the flag is set, regardless of versions", () => {
    expect(
      classifyVersionStatus({
        clientVersion: "0.1.0-alpha.5",
        serverVersion: "0.1.0-alpha.5",
        updateRequired: true,
      }),
    ).toBe("update_required");
    // Even a newer client is "update_required" if the handshake refused it.
    expect(
      classifyVersionStatus({
        clientVersion: "9.9.9",
        serverVersion: "0.1.0",
        updateRequired: true,
      }),
    ).toBe("update_required");
  });

  it("is up_to_date when the client equals or leads the server", () => {
    expect(
      classifyVersionStatus({
        clientVersion: "0.1.0-alpha.5",
        serverVersion: "0.1.0-alpha.5",
        updateRequired: false,
      }),
    ).toBe("up_to_date");
    expect(
      classifyVersionStatus({
        clientVersion: "0.2.0",
        serverVersion: "0.1.0",
        updateRequired: false,
      }),
    ).toBe("up_to_date");
  });

  it("is outdated when the client trails the server (the incident case)", () => {
    expect(
      classifyVersionStatus({
        clientVersion: "0.1.0-alpha.4",
        serverVersion: "0.1.0-alpha.5",
        updateRequired: false,
      }),
    ).toBe("outdated");
  });

  it("is unknown when either version is missing or unparseable", () => {
    expect(
      classifyVersionStatus({
        clientVersion: null,
        serverVersion: "0.1.0-alpha.5",
        updateRequired: false,
      }),
    ).toBe("unknown");
    expect(
      classifyVersionStatus({
        clientVersion: "0.1.0-alpha.5",
        serverVersion: null,
        updateRequired: false,
      }),
    ).toBe("unknown");
    expect(
      classifyVersionStatus({
        clientVersion: "nightly-build",
        serverVersion: "0.1.0",
        updateRequired: false,
      }),
    ).toBe("unknown");
  });
});
