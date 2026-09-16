/**
 * Tests for the timekpr-mirror fetch/refresh (#392).
 *
 * Network (`fetch`), filesystem, and the retry clock (`sleep`) are injected, so
 * no test touches the real network or disk: a fake `fetch` serves the Launchpad
 * `getPublishedBinaries` + `binaryFileUrls` responses and a `.deb` body, and an
 * in-memory file map stands in for the data volume. Covers latest/pinned
 * resolution, skip-when-current idempotency, the structural `.deb` check, and the
 * download/parse/retry failure paths.
 */
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  TimekprMirrorDownloadError,
  TimekprMirrorInvalidPackageError,
  VERSION_SENTINEL,
  refreshTimekprMirror,
  type DownloadFetch,
  type RefreshDeps,
} from "../../../src/transport/timekpr-mirror/refresh.js";
import { TimekprMirrorResolveError } from "../../../src/transport/timekpr-mirror/release.js";

const DATA_DIR = "/data/apt/timekpr";
const PKG = "timekpr-next";
const SELF = "https://api.launchpad.net/devel/~mjasnik/+archive/ubuntu/ppa/+binarypub/1";
const FILES = "https://launchpad.net/~mjasnik/+archive/ubuntu/ppa/+files";

/** A minimal valid `.deb`: the Debian ar global header followed by content. */
function debBody(): Buffer {
  return Buffer.concat([Buffer.from("!<arch>\n", "ascii"), Buffer.from("payload")]);
}

interface Routes {
  /** Versions to publish, newest first (drives getPublishedBinaries). */
  versions?: string[];
  /** File URLs returned by binaryFileUrls (defaults to the _all.deb for versions[0]). */
  fileUrls?: string[];
  /** Body returned for a .deb download (defaults to a valid .deb). */
  deb?: Buffer;
  /** URL substrings that should fail with a status instead of succeeding. */
  fail?: { match: string; status: number; statusText: string };
}

function fakeFetch(routes: Routes): { fetch: DownloadFetch; calls: string[] } {
  const calls: string[] = [];
  const versions = routes.versions ?? ["0.5.7-1"];
  const fileUrls = routes.fileUrls ?? [`${FILES}/${PKG}_${versions[0]}_all.deb`];
  const deb = routes.deb ?? debBody();

  const fetch: DownloadFetch = async (url) => {
    calls.push(url);
    const notFound = {
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({}),
    };
    if (routes.fail && url.includes(routes.fail.match)) {
      return { ...notFound, status: routes.fail.status, statusText: routes.fail.statusText };
    }
    if (url.includes("ws.op=getPublishedBinaries")) {
      return {
        ...notFound,
        ok: true,
        status: 200,
        json: async () => ({
          entries: versions.map((version) => ({
            binary_package_name: PKG,
            binary_package_version: version,
            self_link: SELF,
          })),
        }),
      };
    }
    if (url.includes("ws.op=binaryFileUrls")) {
      return { ...notFound, ok: true, status: 200, json: async () => fileUrls };
    }
    if (url.endsWith(".deb")) {
      return {
        ...notFound,
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          const ab = new ArrayBuffer(deb.byteLength);
          new Uint8Array(ab).set(deb);
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
  deps: Pick<RefreshDeps, "fileExists" | "readSentinel" | "makeDir" | "writeDeb" | "writeSentinel">;
} {
  const files = new Map<string, Buffer | string>(Object.entries(initial));
  return {
    files,
    deps: {
      fileExists: (path) => files.has(path),
      readSentinel: (path) => {
        const value = files.get(path);
        return typeof value === "string" ? value.trim() : null;
      },
      makeDir: () => undefined,
      writeDeb: (path, contents) => void files.set(path, contents),
      writeSentinel: (path, value) => void files.set(path, `${value}\n`),
    },
  };
}

/** Deps with no real timers: `sleep` resolves immediately. */
function seams(routes: Routes, fs = memFs()): { deps: RefreshDeps; calls: string[] } {
  const { fetch, calls } = fakeFetch(routes);
  return { deps: { fetch, sleep: async () => undefined, ...fs.deps }, calls };
}

describe("refreshTimekprMirror", () => {
  it("downloads the newest .deb and records the sentinel on first run", async () => {
    const fs = memFs();
    const { deps } = seams({ versions: ["0.5.7-1", "0.5.6-1"] }, fs);

    const result = await refreshTimekprMirror({ dataDir: DATA_DIR, package: PKG }, deps);

    expect(result).toEqual({
      version: "0.5.7-1",
      filename: "timekpr-next_0.5.7-1_all.deb",
      path: join(DATA_DIR, "timekpr-next_0.5.7-1_all.deb"),
      fetched: true,
    });
    expect(fs.files.get(join(DATA_DIR, "timekpr-next_0.5.7-1_all.deb"))).toBeInstanceOf(Buffer);
    expect(fs.files.get(join(DATA_DIR, VERSION_SENTINEL))).toBe("0.5.7-1\n");
  });

  it("is a no-op when the resolved version is already current", async () => {
    const path = join(DATA_DIR, "timekpr-next_0.5.7-1_all.deb");
    const fs = memFs({ [path]: "existing", [join(DATA_DIR, VERSION_SENTINEL)]: "0.5.7-1\n" });
    const { deps, calls } = seams({ versions: ["0.5.7-1"] }, fs);

    const result = await refreshTimekprMirror({ dataDir: DATA_DIR, package: PKG }, deps);

    expect(result.fetched).toBe(false);
    expect(result.version).toBe("0.5.7-1");
    // Only the getPublishedBinaries lookup ran — no binaryFileUrls, no download.
    expect(calls.some((u) => u.includes("ws.op=binaryFileUrls"))).toBe(false);
    expect(calls.some((u) => u.endsWith(".deb"))).toBe(false);
  });

  it("re-fetches when the sentinel drifts from the resolved version", async () => {
    const oldPath = join(DATA_DIR, "timekpr-next_0.5.6-1_all.deb");
    const fs = memFs({ [oldPath]: "old", [join(DATA_DIR, VERSION_SENTINEL)]: "0.5.6-1\n" });
    const { deps } = seams({ versions: ["0.5.7-1"] }, fs);

    const result = await refreshTimekprMirror({ dataDir: DATA_DIR, package: PKG }, deps);

    expect(result).toMatchObject({ version: "0.5.7-1", fetched: true });
    expect(fs.files.get(join(DATA_DIR, VERSION_SENTINEL))).toBe("0.5.7-1\n");
  });

  it("re-fetches when the sentinel matches but the .deb file is missing", async () => {
    const fs = memFs({ [join(DATA_DIR, VERSION_SENTINEL)]: "0.5.7-1\n" });
    const { deps } = seams({ versions: ["0.5.7-1"] }, fs);

    const result = await refreshTimekprMirror({ dataDir: DATA_DIR, package: PKG }, deps);

    expect(result.fetched).toBe(true);
  });

  it("honours a pinned version instead of the newest", async () => {
    const fs = memFs();
    const { deps } = seams(
      {
        versions: ["0.5.7-1", "0.5.6-1"],
        fileUrls: [`${FILES}/${PKG}_0.5.6-1_all.deb`],
      },
      fs,
    );

    const result = await refreshTimekprMirror(
      { dataDir: DATA_DIR, package: PKG, version: "0.5.6-1" },
      deps,
    );

    expect(result.version).toBe("0.5.6-1");
    expect(result.filename).toBe("timekpr-next_0.5.6-1_all.deb");
  });

  it("throws a resolve error when a pinned version is not published", async () => {
    const { deps } = seams({ versions: ["0.5.7-1"] });
    await expect(
      refreshTimekprMirror({ dataDir: DATA_DIR, package: PKG, version: "0.1.0-1" }, deps),
    ).rejects.toThrow(TimekprMirrorResolveError);
  });

  it("wraps a non-2xx download in TimekprMirrorDownloadError", async () => {
    const { deps } = seams({
      versions: ["0.5.7-1"],
      fail: { match: ".deb", status: 503, statusText: "Unavailable" },
    });
    await expect(
      refreshTimekprMirror({ dataDir: DATA_DIR, package: PKG }, deps),
    ).rejects.toBeInstanceOf(TimekprMirrorDownloadError);
  });

  it("rejects a body that is not a Debian package", async () => {
    const { deps } = seams({ versions: ["0.5.7-1"], deb: Buffer.from("<html>oops</html>") });
    await expect(
      refreshTimekprMirror({ dataDir: DATA_DIR, package: PKG }, deps),
    ).rejects.toBeInstanceOf(TimekprMirrorInvalidPackageError);
  });

  it("retries a transient failure and eventually succeeds", async () => {
    let attempts = 0;
    const inner = fakeFetch({ versions: ["0.5.7-1"] }).fetch;
    const fetchImpl: DownloadFetch = async (url, init) => {
      if (url.includes("ws.op=getPublishedBinaries")) {
        attempts += 1;
        if (attempts < 3) throw new Error("connection reset");
      }
      return inner(url, init);
    };
    const sleep = vi.fn(async () => undefined);
    const result = await refreshTimekprMirror(
      { dataDir: DATA_DIR, package: PKG },
      { fetch: fetchImpl, sleep, ...memFs().deps },
    );
    expect(result.fetched).toBe(true);
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("propagates the last error when retries are exhausted", async () => {
    const fetchImpl: DownloadFetch = async () => {
      throw new Error("connection reset");
    };
    await expect(
      refreshTimekprMirror(
        { dataDir: DATA_DIR, package: PKG },
        { fetch: fetchImpl, sleep: async () => undefined, retryAttempts: 2, ...memFs().deps },
      ),
    ).rejects.toThrow("connection reset");
  });

  it("clamps a non-positive retryAttempts to a single attempt", async () => {
    // retryAttempts: 0 must still run once (clamped) and surface the real error,
    // never an `undefined` "last error" from a loop that never entered.
    const fetchImpl: DownloadFetch = async () => {
      throw new Error("connection reset");
    };
    await expect(
      refreshTimekprMirror(
        { dataDir: DATA_DIR, package: PKG },
        { fetch: fetchImpl, sleep: async () => undefined, retryAttempts: 0, ...memFs().deps },
      ),
    ).rejects.toThrow("connection reset");
  });
});
