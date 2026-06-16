/**
 * Logging configuration tests (#11).
 *
 * Captures the pino output via a destination stream (the `loggerStream` test
 * seam on `buildApp`) and asserts request-ID propagation, the `pino-pretty`
 * opt-in, and the `componentLogger` convention.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/web/app.js";
import { buildLoggerOptions, componentLogger, genRequestId } from "../../src/web/logger.js";
import { loadSettings } from "../../src/config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Collect JSON log lines pino writes to the destination stream. */
function collectStream(): {
  stream: { write(msg: string): void };
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  return {
    stream: {
      write(msg: string) {
        lines.push(JSON.parse(msg) as Record<string, unknown>);
      },
    },
    lines,
  };
}

describe("request-id logging", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("honours an inbound X-Request-Id on request-scoped log lines", async () => {
    const { stream, lines } = collectStream();
    app = buildApp({ settings: loadSettings({ PCT_LOG_LEVEL: "info" }), loggerStream: stream });

    await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "calendar-webhook-42" },
    });

    const requestLines = lines.filter((l) => l.reqId !== undefined);
    expect(requestLines.length).toBeGreaterThan(0);
    for (const line of requestLines) {
      expect(line.reqId).toBe("calendar-webhook-42");
    }
  });

  it("generates a UUID request id when no header is present", async () => {
    const { stream, lines } = collectStream();
    app = buildApp({ settings: loadSettings({ PCT_LOG_LEVEL: "info" }), loggerStream: stream });

    await app.inject({ method: "GET", url: "/healthz" });

    const requestLine = lines.find((l) => l.reqId !== undefined);
    expect(requestLine).toBeDefined();
    expect(requestLine?.reqId).toMatch(UUID_RE);
  });

  it("componentLogger binds a component field to non-request log lines", async () => {
    const { stream, lines } = collectStream();
    app = buildApp({ settings: loadSettings({ PCT_LOG_LEVEL: "info" }), loggerStream: stream });

    componentLogger(app, "transport/ssh").info("ssh command issued");

    const line = lines.find((l) => l.component === "transport/ssh");
    expect(line).toBeDefined();
    expect(line?.msg).toBe("ssh command issued");
    // A component logger is for non-request sources, so it carries no reqId.
    expect(line?.reqId).toBeUndefined();
  });
});

describe("buildLoggerOptions", () => {
  it("defaults to JSON at the configured level", () => {
    expect(buildLoggerOptions(loadSettings({ PCT_LOG_LEVEL: "warn" }))).toEqual({ level: "warn" });
  });

  it("uses the pino-pretty transport when logPretty is enabled", () => {
    expect(buildLoggerOptions(loadSettings({ PCT_LOG_PRETTY: "true" }))).toMatchObject({
      level: "info",
      transport: { target: "pino-pretty" },
    });
  });

  it("prefers an explicit stream over the pretty transport", () => {
    const { stream } = collectStream();
    expect(buildLoggerOptions(loadSettings({ PCT_LOG_PRETTY: "true" }), stream)).toEqual({
      level: "info",
      stream,
    });
  });
});

describe("genRequestId", () => {
  it("returns unique UUIDs", () => {
    const a = genRequestId();
    const b = genRequestId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});
