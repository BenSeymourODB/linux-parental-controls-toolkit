/**
 * Unit tests for the timekpr-mirror refresh scheduler (#392): the tick that runs
 * a refresh pass, logs its outcome, catches + backs off failures (so a tick
 * never throws), clears backoff on success, and the start/stop lifecycle. The
 * cron schedule itself isn't fired — `tick()` (the same function each cron tick
 * invokes) is driven directly, exactly like the reapply scheduler tests.
 */
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { DownloadFetch, RefreshDeps } from "../../../src/transport/timekpr-mirror/index.js";
import {
  DEFAULT_REFRESH_BACKOFF,
  DEFAULT_REFRESH_PATTERN,
  REFRESH_LOG_COMPONENT,
  startTimekprMirrorRefresh,
  type TimekprMirrorRefreshHandle,
  type TimekprMirrorRefreshOptions,
} from "../../../src/transport/timekpr-mirror/index.js";

const CONFIG = { dataDir: "/data/apt/timekpr", package: "timekpr-next" };
const SELF = "https://api.launchpad.net/devel/~mjasnik/+archive/ubuntu/ppa/+binarypub/1";
const DEB =
  "https://launchpad.net/~mjasnik/+archive/ubuntu/ppa/+files/timekpr-next_0.5.7-1_all.deb";

/** A capturing logger that records every line by level. */
function capturingLog(): { log: FastifyBaseLogger; lines: { level: string; obj: unknown }[] } {
  const lines: { level: string; obj: unknown }[] = [];
  const record =
    (level: string) =>
    (obj: unknown): void =>
      void lines.push({ level, obj });
  const log = {
    child: () => log,
    info: record("info"),
    warn: record("warn"),
    debug: record("debug"),
    error: record("error"),
    fatal: record("fatal"),
    trace: record("trace"),
  } as unknown as FastifyBaseLogger;
  return { log, lines };
}

/** A `fetch` that serves the Launchpad lookups + a valid `.deb` body. */
function buildOkFetch(): DownloadFetch {
  const deb = Buffer.concat([Buffer.from("!<arch>\n", "ascii"), Buffer.from("x")]);
  return async (url) => {
    const base = {
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(deb.byteLength);
        new Uint8Array(ab).set(deb);
        return ab;
      },
      text: async () => "",
      json: async () => ({}),
    };
    if (url.includes("ws.op=getPublishedBinaries")) {
      return {
        ...base,
        json: async () => ({
          entries: [
            {
              binary_package_name: "timekpr-next",
              binary_package_version: "0.5.7-1",
              self_link: SELF,
            },
          ],
        }),
      };
    }
    if (url.includes("ws.op=binaryFileUrls")) {
      return { ...base, json: async () => [DEB] };
    }
    return base;
  };
}

/** In-memory refresh seams: a `.deb` body, controllable per-URL, no real timers. */
function refreshSeams(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    fetch: buildOkFetch(),
    fileExists: () => false,
    readSentinel: () => null,
    makeDir: () => undefined,
    writeDeb: () => undefined,
    writeSentinel: () => undefined,
    sleep: async () => undefined,
    ...overrides,
  };
}

function start(options: Partial<TimekprMirrorRefreshOptions>, log: FastifyBaseLogger) {
  return startTimekprMirrorRefresh({ config: CONFIG, log, ...options });
}

describe("startTimekprMirrorRefresh", () => {
  const handles: TimekprMirrorRefreshHandle[] = [];
  const track = (h: TimekprMirrorRefreshHandle): TimekprMirrorRefreshHandle => {
    handles.push(h);
    return h;
  };
  // Stop every scheduler a test started so no cron timer leaks between tests.
  afterEach(() => {
    while (handles.length > 0) handles.pop()?.stop();
  });

  it("exposes the default pattern, backoff, and log component", () => {
    expect(DEFAULT_REFRESH_PATTERN).toBe("0 3 * * *");
    expect(DEFAULT_REFRESH_BACKOFF.baseMs).toBeGreaterThan(0);
    expect(DEFAULT_REFRESH_BACKOFF.maxMs).toBeGreaterThan(DEFAULT_REFRESH_BACKOFF.baseMs);
    expect(REFRESH_LOG_COMPONENT).toBe("transport/timekpr-mirror");
  });

  it("runs a refresh on tick and logs the fetched version", async () => {
    const { log, lines } = capturingLog();
    const handle = track(start({ refreshDeps: refreshSeams() }, log));

    await handle.tick();

    const info = lines.find((l) => l.level === "info");
    expect(info?.obj).toMatchObject({ version: "0.5.7-1" });
    handle.stop();
  });

  it("logs debug (not info) when the mirror is already current", async () => {
    const { log, lines } = capturingLog();
    const deps = refreshSeams({
      fileExists: () => true,
      readSentinel: () => "0.5.7-1",
    });
    const handle = track(start({ refreshDeps: deps }, log));

    await handle.tick();

    expect(lines.some((l) => l.level === "info")).toBe(false);
    expect(lines.some((l) => l.level === "debug")).toBe(true);
    handle.stop();
  });

  it("catches a failed refresh, never throws, and backs off", async () => {
    const { log, lines } = capturingLog();
    const clock = 1000;
    const deps = refreshSeams({
      fetch: async () => {
        throw new Error("launchpad unreachable");
      },
      retryAttempts: 1,
    });
    const handle = track(start({ refreshDeps: deps, now: () => clock }, log));

    await expect(handle.tick()).resolves.toBeUndefined();
    const warn = lines.find((l) => l.level === "warn");
    expect(warn?.obj).toMatchObject({ failures: 1 });

    // The next tick, still within the backoff window, is skipped (no new warn).
    const warnsBefore = lines.filter((l) => l.level === "warn").length;
    await handle.tick();
    expect(lines.filter((l) => l.level === "warn").length).toBe(warnsBefore);
    handle.stop();
  });

  it("clears the backoff after a later success", async () => {
    const { log, lines } = capturingLog();
    let clock = 1000;
    let failNext = true;
    const okFetch = buildOkFetch();
    const deps = refreshSeams({
      fetch: async (url, init) => {
        if (failNext) throw new Error("transient");
        return okFetch(url, init);
      },
      retryAttempts: 1,
    });
    const handle = track(start({ refreshDeps: deps, now: () => clock }, log));

    await handle.tick(); // fails, backs off
    clock += DEFAULT_REFRESH_BACKOFF.maxMs; // jump past the backoff window
    failNext = false;
    await handle.tick(); // succeeds, clears backoff

    expect(lines.some((l) => l.level === "info")).toBe(true);
    handle.stop();
  });

  it("stop() halts the schedule without throwing", () => {
    const { log } = capturingLog();
    const handle = start({ refreshDeps: refreshSeams() }, log);
    expect(() => handle.stop()).not.toThrow();
  });
});
