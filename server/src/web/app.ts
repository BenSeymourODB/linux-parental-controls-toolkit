/**
 * Fastify app composition.
 *
 * `buildApp()` is a factory (not a module-level singleton) so tests can
 * construct isolated instances and exercise routes via `app.inject()`
 * without binding a socket — see docs/testing.md → "HTTP routes".
 *
 * This is the minimal Phase 1 slice: a "hello, no policy yet" landing
 * route and a `/healthz` probe, plus the shared pino logging configuration
 * (#11). The policy/api/integrations mounts land in later phases.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { loadSettings, type Settings } from "../config.js";
import { REQUEST_ID_HEADER, buildLoggerOptions, genRequestId, type LogStream } from "./logger.js";

/** Options for {@link buildApp}. */
export interface BuildAppOptions {
  /** Parsed settings; defaults to {@link loadSettings} reading `process.env`. */
  settings?: Settings;
  /**
   * Test seam: capture log output via a pino destination stream. Takes
   * precedence over the `pino-pretty` transport.
   */
  loggerStream?: LogStream;
}

/**
 * Build and configure a Fastify instance.
 *
 * The logger follows the shared conventions in `./logger.ts` (#11): JSON by
 * default at `PCT_LOG_LEVEL`, an inbound `X-Request-Id` honoured with a UUID
 * fallback, and `reqId` bound to every request-scoped log line.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const settings = options.settings ?? loadSettings();

  const app = Fastify({
    logger: buildLoggerOptions(settings, options.loggerStream),
    // Honour an inbound X-Request-Id; genReqId supplies the UUID fallback.
    // Either way the id is bound to every request-scoped log line as `reqId`.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: genRequestId,
  });

  app.get("/", async (_request, reply) => {
    return reply.type("text/plain").send("hello, no policy yet");
  });

  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  return app;
}
