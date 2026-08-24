/**
 * Tests for the enrol-time timekpr mirror advertisement builder (#393).
 *
 * The pure `buildTimekprMirrorAdvertisement` maps each config mode; the
 * `resolveTimekprMirrorAdvertisement` wrapper reads on-disk state in managed
 * mode (via injected seams here, so no real disk) and never reads in
 * disabled/external mode.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Settings } from "../../../src/config.js";
import {
  buildTimekprMirrorAdvertisement,
  resolveTimekprMirrorAdvertisement,
  TIMEKPR_MIRROR_APT_PATH,
} from "../../../src/api/clients/mirror-advertisement.js";
import { VERSION_SENTINEL } from "../../../src/transport/timekpr-mirror/index.js";

const DATA_DIR = "/data/apt/timekpr";

const managed = (overrides: Partial<Settings["timekprMirror"]> = {}): Settings["timekprMirror"] =>
  ({
    mode: "managed",
    dataDir: DATA_DIR,
    package: "timekpr-next",
    refreshCron: "0 3 * * *",
    ...overrides,
  }) as Settings["timekprMirror"];

describe("buildTimekprMirrorAdvertisement", () => {
  it("advertises nothing to configure when disabled", () => {
    expect(buildTimekprMirrorAdvertisement({ mode: "disabled" }, null)).toEqual({
      mode: "disabled",
    });
  });

  it("passes through the external repo URL", () => {
    expect(
      buildTimekprMirrorAdvertisement({ mode: "external", url: "https://apt.lan/timekpr" }, null),
    ).toEqual({ mode: "external", url: "https://apt.lan/timekpr" });
  });

  it("advertises the served path + package with a populated version when cached", () => {
    const state = {
      version: "0.5.5",
      filename: "timekpr-next_0.5.5_all.deb",
      path: join(DATA_DIR, "timekpr-next_0.5.5_all.deb"),
    };
    expect(buildTimekprMirrorAdvertisement(managed(), state)).toEqual({
      mode: "managed",
      aptPath: TIMEKPR_MIRROR_APT_PATH,
      package: "timekpr-next",
      version: "0.5.5",
      debFilename: "timekpr-next_0.5.5_all.deb",
    });
  });

  it("reports null version/filename on a managed cold start (nothing cached)", () => {
    expect(
      buildTimekprMirrorAdvertisement(managed({ package: "timekpr-next-beta" }), null),
    ).toEqual({
      mode: "managed",
      aptPath: TIMEKPR_MIRROR_APT_PATH,
      package: "timekpr-next-beta",
      version: null,
      debFilename: null,
    });
  });
});

describe("resolveTimekprMirrorAdvertisement", () => {
  it("reads managed state from disk (seams) and reflects the cached version", () => {
    const filename = "timekpr-next_0.5.5_all.deb";
    const path = join(DATA_DIR, filename);
    const ad = resolveTimekprMirrorAdvertisement(managed(), {
      readSentinel: (p) => (p === join(DATA_DIR, VERSION_SENTINEL) ? "0.5.5" : null),
      fileExists: (p) => p === path,
    });
    expect(ad).toEqual({
      mode: "managed",
      aptPath: TIMEKPR_MIRROR_APT_PATH,
      package: "timekpr-next",
      version: "0.5.5",
      debFilename: filename,
    });
  });

  it("reflects a managed cold start as null coordinates", () => {
    const ad = resolveTimekprMirrorAdvertisement(managed(), {
      readSentinel: () => null,
      fileExists: () => false,
    });
    expect(ad).toMatchObject({ mode: "managed", version: null, debFilename: null });
  });

  it("does not read disk for disabled/external modes", () => {
    // A throwing seam would surface if the resolver read state; it must not.
    const throwing = {
      readSentinel: () => {
        throw new Error("must not read disk when not managed");
      },
      fileExists: () => {
        throw new Error("must not read disk when not managed");
      },
    };
    expect(resolveTimekprMirrorAdvertisement({ mode: "disabled" }, throwing)).toEqual({
      mode: "disabled",
    });
    expect(
      resolveTimekprMirrorAdvertisement({ mode: "external", url: "https://apt.lan/x" }, throwing),
    ).toEqual({ mode: "external", url: "https://apt.lan/x" });
  });
});
