/**
 * Tests for the AdGuard Home release-coordinate helpers (#96): platform/arch →
 * asset mapping, URL builders, and checksum-line parsing. All pure — no I/O.
 */
import { describe, expect, it } from "vitest";

import {
  ADGUARD_REPO,
  assetUrl,
  checksumsUrl,
  findChecksum,
  resolveAsset,
  UnsupportedPlatformError,
} from "../../../src/transport/adguard/release.js";

describe("resolveAsset", () => {
  it.each([
    ["x64", "linux_amd64"],
    ["arm64", "linux_arm64"],
    ["ia32", "linux_386"],
    ["arm", "linux_armv7"],
  ])("maps linux/%s to %s", (arch, token) => {
    const asset = resolveAsset("linux", arch);
    expect(asset.platform).toBe(token);
    expect(asset.assetName).toBe(`AdGuardHome_${token}.tar.gz`);
  });

  it("rejects a non-linux platform", () => {
    expect(() => resolveAsset("darwin", "x64")).toThrow(UnsupportedPlatformError);
  });

  it("rejects an unmapped architecture", () => {
    expect(() => resolveAsset("linux", "riscv64")).toThrow(UnsupportedPlatformError);
  });
});

describe("URL builders", () => {
  const asset = resolveAsset("linux", "x64");

  it("builds the asset download URL", () => {
    expect(assetUrl("v0.107.65", asset)).toBe(
      `https://github.com/${ADGUARD_REPO}/releases/download/v0.107.65/AdGuardHome_linux_amd64.tar.gz`,
    );
  });

  it("builds the checksums URL", () => {
    expect(checksumsUrl("v0.107.65")).toBe(
      `https://github.com/${ADGUARD_REPO}/releases/download/v0.107.65/checksums.txt`,
    );
  });
});

describe("findChecksum", () => {
  const digest = "a".repeat(64);
  const other = "b".repeat(64);

  it("finds the digest for the requested asset", () => {
    const body = `${other}  AdGuardHome_linux_arm64.tar.gz\n${digest}  AdGuardHome_linux_amd64.tar.gz\n`;
    expect(findChecksum(body, "AdGuardHome_linux_amd64.tar.gz")).toBe(digest);
  });

  it("tolerates a ./ filename prefix and upper-case hex", () => {
    const body = `${digest.toUpperCase()}  ./AdGuardHome_linux_amd64.tar.gz`;
    expect(findChecksum(body, "AdGuardHome_linux_amd64.tar.gz")).toBe(digest);
  });

  it("returns null when the asset is absent", () => {
    const body = `${other}  AdGuardHome_linux_arm64.tar.gz`;
    expect(findChecksum(body, "AdGuardHome_linux_amd64.tar.gz")).toBeNull();
  });

  it("ignores blank and malformed lines", () => {
    const body = `\n   \nnot-a-checksum-line\n${digest}  AdGuardHome_linux_amd64.tar.gz`;
    expect(findChecksum(body, "AdGuardHome_linux_amd64.tar.gz")).toBe(digest);
  });
});
