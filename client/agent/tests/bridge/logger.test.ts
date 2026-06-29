import { describe, expect, it, vi } from "vitest";

import { StreamLogger, type LogSinks } from "../../src/bridge/logger.js";

/** A capturing sink pair for assertions. */
function captureSinks(): { sinks: LogSinks; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    sinks: { out: { write: (c) => out.push(c) }, err: { write: (c) => err.push(c) } },
  };
}

function makeLogger(sinks: LogSinks) {
  return new StreamLogger({ component: "test-bridge", sinks, now: () => 1_750_000_000_000 });
}

describe("StreamLogger", () => {
  it("emits one JSON line per call with at/level/component/msg and fields", () => {
    const { sinks, out } = captureSinks();
    makeLogger(sinks).info({ uid: 1001, seq: 9 }, "dispatched");

    expect(out).toHaveLength(1);
    expect(out[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(out[0] as string)).toEqual({
      at: "2025-06-15T15:06:40.000Z",
      level: "info",
      component: "test-bridge",
      msg: "dispatched",
      uid: 1001,
      seq: 9,
    });
  });

  it("routes warn and error to stderr, debug and info to stdout", () => {
    const { sinks, out, err } = captureSinks();
    const log = makeLogger(sinks);
    log.debug({}, "d");
    log.info({}, "i");
    log.warn({}, "w");
    log.error({}, "e");

    expect(out.map((l) => JSON.parse(l).level)).toEqual(["debug", "info"]);
    expect(err.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
  });

  it("defaults to the process streams when no sinks are given", () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const log = new StreamLogger({ now: () => 0 });
      log.info({}, "to-stdout");
      log.error({}, "to-stderr");
      expect(outSpy).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(outSpy.mock.calls[0]?.[0])).toContain('"component":"pct-client-bridge"');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("reduces an Error field value to { name, message }", () => {
    const { sinks, err } = captureSinks();
    makeLogger(sinks).error({ cause: new TypeError("boom") }, "failed");
    expect(JSON.parse(err[0] as string).cause).toEqual({ name: "TypeError", message: "boom" });
  });
});
