/**
 * Tests for the AdGuard Home first-run acquisition (#96).
 *
 * Network (`fetch`) and filesystem are injected, so no test touches the real
 * network or disk: a fake `fetch` serves a hand-built release archive +
 * `checksums.txt` + latest-release JSON, and an in-memory file map stands in for
 * the data volume. Covers idempotency, checksum verification, version
 * resolution, and the download/parse failure paths.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireAdGuardHome,
  AdGuardChecksumError,
  AdGuardDownloadError,
  type AcquireDeps,
  type DownloadFetch,
} from "../../../src/transport/adguard/acquire.js";

const DATA_DIR = "/data/adguard";
const BINARY_PATH = join(DATA_DIR, "AdGuardHome");
const SENTINEL_PATH = join(DATA_DIR, ".pct-adguard-version");
const ASSET = "AdGuardHome_linux_amd64.tar.gz";
const VERSION = "v0.107.65";
const BLOCK = 512;

const BINARY_BODY = Buffer.from("#!/bin/sh\necho adguard-home\n");

function tarEntry(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, "ascii");
  header.write(contents.length.toString(8).padStart(11, "0"), 124, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  const data = Buffer.alloc(Math.ceil(contents.length / BLOCK) * BLOCK);
  contents.copy(data);
  return Buffer.concat([header, data]);
}

function buildArchive(): Buffer {
  const trailer = Buffer.alloc(BLOCK * 2);
  return gzipSync(Buffer.concat([tarEntry("AdGuardHome/AdGuardHome", BINARY_BODY), trailer]));
}

const ARCHIVE = buildArchive();
const ARCHIVE_SHA256 = createHash("sha256").update(ARCHIVE).digest("hex");

/** Build a fake `fetch` serving the release endpoints; missing URLs 404. */
function fakeFetch(routes: { archive?: Buffer; checksums?: string; latestTag?: string }): {
  fetch: DownloadFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: DownloadFetch = async (input) => {
    const url = input;
    calls.push(url);
    const notFound = {
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({}),
    };
    if (url.endsWith("/releases/latest")) {
      if (routes.latestTag === undefined) return notFound;
      return {
        ...notFound,
        ok: true,
        status: 200,
        json: async () => ({ tag_name: routes.latestTag }),
      };
    }
    if (url.endsWith("checksums.txt")) {
      const body = routes.checksums;
      if (body === undefined) return notFound;
      return { ...notFound, ok: true, status: 200, text: async () => body };
    }
    if (url.endsWith(ASSET)) {
      if (routes.archive === undefined) return notFound;
      const buf = routes.archive;
      return {
        ...notFound,
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          const ab = new ArrayBuffer(buf.byteLength);
          new Uint8Array(ab).set(buf);
          return ab;
        },
      };
    }
    return notFound;
  };
  return { fetch, calls };
}

/** In-memory filesystem seams over a `Map<path, contents>`. */
function memFs(initial: Record<string, string> = {}): {
  files: Map<string, Buffer | string>;
  deps: Pick<
    AcquireDeps,
    "fileExists" | "readSentinel" | "makeDir" | "writeBinary" | "writeSentinel"
  >;
} {
  const files = new Map<string, Buffer | string>(Object.entries(initial));
  return {
    files,
    deps: {
      fileExists: (p) => files.has(p),
      readSentinel: (p) => {
        const v = files.get(p);
        return typeof v === "string" ? v.trim() : null;
      },
      makeDir: () => undefined,
      writeBinary: (p, c) => void files.set(p, c),
      writeSentinel: (p, v) => void files.set(p, `${v}\n`),
    },
  };
}

describe("acquireAdGuardHome", () => {
  it("downloads, verifies the checksum, and extracts the binary (pinned)", async () => {
    const { fetch, calls } = fakeFetch({
      archive: ARCHIVE,
      checksums: `${ARCHIVE_SHA256}  ${ASSET}\n`,
    });
    const { files, deps } = memFs();

    const result = await acquireAdGuardHome(
      { dataDir: DATA_DIR, version: VERSION },
      { fetch, ...deps },
    );

    expect(result).toEqual({ binaryPath: BINARY_PATH, version: VERSION, fetched: true });
    expect((files.get(BINARY_PATH) as Buffer).equals(BINARY_BODY)).toBe(true);
    expect(files.get(SENTINEL_PATH)).toBe(`${VERSION}\n`);
    // Pinned: never calls the latest-release API.
    expect(calls.some((u) => u.endsWith("/releases/latest"))).toBe(false);
  });

  it("resolves the latest tag when unpinned and absent", async () => {
    const { fetch, calls } = fakeFetch({
      archive: ARCHIVE,
      checksums: `${ARCHIVE_SHA256}  ${ASSET}\n`,
      latestTag: VERSION,
    });
    const { deps } = memFs();

    const result = await acquireAdGuardHome({ dataDir: DATA_DIR }, { fetch, ...deps });

    expect(result.version).toBe(VERSION);
    expect(result.fetched).toBe(true);
    expect(calls[0]).toContain("/releases/latest");
  });

  it("is a no-op when the binary is already present and unpinned", async () => {
    const { fetch, calls } = fakeFetch({});
    const { deps } = memFs({ [BINARY_PATH]: "existing", [SENTINEL_PATH]: "v0.107.60" });

    const result = await acquireAdGuardHome({ dataDir: DATA_DIR }, { fetch, ...deps });

    expect(result).toEqual({ binaryPath: BINARY_PATH, version: "v0.107.60", fetched: false });
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when present and the pinned version matches the sentinel", async () => {
    const { fetch, calls } = fakeFetch({});
    const { deps } = memFs({ [BINARY_PATH]: "existing", [SENTINEL_PATH]: VERSION });

    const result = await acquireAdGuardHome(
      { dataDir: DATA_DIR, version: VERSION },
      { fetch, ...deps },
    );

    expect(result.fetched).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("re-acquires when present but the pinned version drifts from the sentinel", async () => {
    const { fetch } = fakeFetch({ archive: ARCHIVE, checksums: `${ARCHIVE_SHA256}  ${ASSET}\n` });
    const { files, deps } = memFs({ [BINARY_PATH]: "old", [SENTINEL_PATH]: "v0.107.60" });

    const result = await acquireAdGuardHome(
      { dataDir: DATA_DIR, version: VERSION },
      { fetch, ...deps },
    );

    expect(result.fetched).toBe(true);
    expect(files.get(SENTINEL_PATH)).toBe(`${VERSION}\n`);
  });

  it("rejects a checksum mismatch and writes no binary", async () => {
    const { fetch } = fakeFetch({ archive: ARCHIVE, checksums: `${"0".repeat(64)}  ${ASSET}\n` });
    const { files, deps } = memFs();

    await expect(
      acquireAdGuardHome({ dataDir: DATA_DIR, version: VERSION }, { fetch, ...deps }),
    ).rejects.toBeInstanceOf(AdGuardChecksumError);
    expect(files.has(BINARY_PATH)).toBe(false);
    expect(files.has(SENTINEL_PATH)).toBe(false); // nothing persisted on mismatch
  });

  it("throws when checksums.txt has no entry for the asset", async () => {
    const { fetch } = fakeFetch({
      archive: ARCHIVE,
      checksums: `${ARCHIVE_SHA256}  some-other.tar.gz\n`,
    });
    const { deps } = memFs();

    await expect(
      acquireAdGuardHome({ dataDir: DATA_DIR, version: VERSION }, { fetch, ...deps }),
    ).rejects.toThrow(/no entry for/);
  });

  it("surfaces a non-2xx download as AdGuardDownloadError", async () => {
    const { fetch } = fakeFetch({ checksums: `${ARCHIVE_SHA256}  ${ASSET}\n` }); // archive 404s
    const { deps } = memFs();

    await expect(
      acquireAdGuardHome({ dataDir: DATA_DIR, version: VERSION }, { fetch, ...deps }),
    ).rejects.toBeInstanceOf(AdGuardDownloadError);
  });

  it("throws when the latest-release lookup returns no tag_name", async () => {
    const { fetch } = fakeFetch({
      archive: ARCHIVE,
      checksums: `${ARCHIVE_SHA256}  ${ASSET}\n`,
      latestTag: "", // 200 OK but an empty tag_name
    });
    const { deps } = memFs();

    await expect(acquireAdGuardHome({ dataDir: DATA_DIR }, { fetch, ...deps })).rejects.toThrow(
      /no tag_name/,
    );
  });
});

/**
 * Default-deps path: only `fetch` and `resolveAsset` are injected (the asset is
 * fixed so the test is host-arch-independent), so the real filesystem seams
 * (write the binary `0755`, write/read the sentinel, mkdir) run against a temp
 * dir — covering the production defaults the in-memory fakes above stand in for.
 */
describe("acquireAdGuardHome (default filesystem seams)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-adguard-acquire-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes an executable binary + sentinel, then no-ops on a matching re-run", async () => {
    const { fetch } = fakeFetch({ archive: ARCHIVE, checksums: `${ARCHIVE_SHA256}  ${ASSET}\n` });
    const resolveAsset = (): { platform: string; assetName: string } => ({
      platform: "linux_amd64",
      assetName: ASSET,
    });

    const first = await acquireAdGuardHome(
      { dataDir: dir, version: VERSION },
      { fetch, resolveAsset },
    );
    expect(first.fetched).toBe(true);

    const binaryPath = join(dir, "AdGuardHome");
    expect(readFileSync(binaryPath).equals(BINARY_BODY)).toBe(true);
    // 0o111 = any execute bit set.
    expect(statSync(binaryPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dir, ".pct-adguard-version"), "utf8").trim()).toBe(VERSION);

    // Second run reads the on-disk sentinel via the default reader → no-op.
    const second = await acquireAdGuardHome(
      { dataDir: dir, version: VERSION },
      { fetch, resolveAsset },
    );
    expect(second.fetched).toBe(false);
  });
});
