/**
 * Shared pino/logging configuration for the Fastify app (issue #11).
 *
 * One opinionated setup, configured once in `buildApp()`, so the log sources
 * that arrive in later phases — transport audit logs (Phase 4), Ansible
 * output capture (Phase 6), the event-stream broadcaster (Phase 8b) — all
 * follow the same conventions:
 *
 * - **JSON by default.** Fastify's built-in logger *is* pino, so there is no
 *   new runtime dependency. The level comes from `PCT_LOG_LEVEL` (via the
 *   settings loader). The human-readable `pino-pretty` transport is used only
 *   when `PCT_LOG_PRETTY` is enabled for local dev — it is a dev-only
 *   dependency and never ships in the runtime image.
 * - **A `reqId` on every request-scoped line.** An inbound `X-Request-Id`
 *   header is honoured; otherwise a UUID is generated ({@link genRequestId}).
 *   Route handlers must log via `request.log` (never a module-level logger)
 *   so the field propagates.
 * - **Named child loggers for non-request sources.** Subprocess runners,
 *   croner jobs, and the WebSocket broadcaster take a child logger via
 *   {@link componentLogger} rather than constructing their own pino instance
 *   or reaching for `console.*` (which ESLint `no-console` forbids in `src/`).
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyServerOptions } from "fastify";
import type { Settings } from "../config.js";

/**
 * Request-ID header, lower-cased to match Fastify's normalised header keys.
 * Wired into Fastify's `requestIdHeader` so an inbound value becomes the
 * request id; {@link genRequestId} supplies the fallback.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Minimal pino destination: anything with a line-oriented `write`.
 *
 * Declared locally (rather than importing pino's `DestinationStream`) so the
 * module depends only on the pino that ships inside Fastify — no direct,
 * transitive pino import. Used as a test seam to capture log output.
 */
export interface LogStream {
  write(msg: string): void;
}

/** Fallback request id when no inbound `X-Request-Id` header is present. */
export function genRequestId(): string {
  return randomUUID();
}

// `NonNullable` because the project runs with `exactOptionalPropertyTypes`:
// Fastify's `logger` option is not `| undefined`, so neither is our return.
type LoggerOption = NonNullable<FastifyServerOptions["logger"]>;

/**
 * Build the Fastify `logger` option from settings.
 *
 * @param settings - parsed app settings (`logLevel`, `logPretty`).
 * @param stream - optional pino destination; a test seam for capturing log
 *   output. When supplied it takes precedence over the pretty transport (the
 *   two cannot be combined).
 */
export function buildLoggerOptions(settings: Settings, stream?: LogStream): LoggerOption {
  const level = settings.logLevel;

  if (stream !== undefined) {
    return { level, stream };
  }

  if (settings.logPretty) {
    return {
      level,
      transport: {
        target: "pino-pretty",
        options: { translateTime: "SYS:standard", ignore: "pid,hostname" },
      },
    };
  }

  return { level };
}

/**
 * Named child logger for a non-request log source.
 *
 * Use this instead of constructing a new pino instance or reaching for
 * `console.*`: `const log = componentLogger(app, "transport/ssh")`. Every line
 * the returned logger emits carries the `component` field.
 */
export function componentLogger(app: FastifyInstance, component: string): FastifyBaseLogger {
  return app.log.child({ component });
}
