/**
 * Tests for the timekpr-mirror on-disk state read (#393).
 *
 * The sentinel read and existence check are injected, so no test touches real
 * disk. Covers the cold-start `null` returns (no sentinel, empty sentinel,
 * sentinel names a missing `.deb`), the populated case, and that the `.deb`
 * filename is derived from the shared {@link debFilename} keyed on the package.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { VERSION_SENTINEL } from "../../../src/transport/timekpr-mirror/refresh.js";
import { readMirrorState } from "../../../src/transport/timekpr-mirror/state.js";

const DATA_DIR = "/data/apt/timekpr";
const PKG = "timekpr-next";

/** Build seams from an in-memory map of path -> sentinel value / file present. */
function seams(sentinel: string | null, presentFiles: string[]) {
  const present = new Set(presentFiles);
  return {
    readSentinel: (path: string) => (path === join(DATA_DIR, VERSION_SENTINEL) ? sentinel : null),
    fileExists: (path: string) => present.has(path),
  };
}

describe("readMirrorState", () => {
  it("returns the cached .deb when the sentinel + file are present", () => {
    const filename = `${PKG}_0.5.5_all.deb`;
    const path = join(DATA_DIR, filename);
    const state = readMirrorState({ dataDir: DATA_DIR, package: PKG }, seams("0.5.5", [path]));
    expect(state).toEqual({ version: "0.5.5", filename, path });
  });

  it("derives the filename from the configured package/channel", () => {
    const filename = "timekpr-next-beta_0.5.6_all.deb";
    const path = join(DATA_DIR, filename);
    const state = readMirrorState(
      { dataDir: DATA_DIR, package: "timekpr-next-beta" },
      seams("0.5.6", [path]),
    );
    expect(state?.filename).toBe(filename);
  });

  it("strips a Debian epoch from the filename (never the on-disk name) but keeps the version", () => {
    const filename = `${PKG}_0.5.5_all.deb`;
    const path = join(DATA_DIR, filename);
    const state = readMirrorState({ dataDir: DATA_DIR, package: PKG }, seams("1:0.5.5", [path]));
    // The sentinel version is reported verbatim; only the filename drops the epoch.
    expect(state).toEqual({ version: "1:0.5.5", filename, path });
  });

  it("returns null when no sentinel is present (cold start)", () => {
    expect(readMirrorState({ dataDir: DATA_DIR, package: PKG }, seams(null, []))).toBeNull();
  });

  it("returns null when the sentinel is empty", () => {
    expect(readMirrorState({ dataDir: DATA_DIR, package: PKG }, seams("", []))).toBeNull();
  });

  it("returns null when the sentinel names a .deb that is not on disk", () => {
    // Sentinel says 0.5.5 but nothing is present — a half-written/removed cache.
    expect(readMirrorState({ dataDir: DATA_DIR, package: PKG }, seams("0.5.5", []))).toBeNull();
  });
});
