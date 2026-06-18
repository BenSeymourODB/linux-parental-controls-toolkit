/**
 * Error taxonomy for the ActivityWatch REST client.
 *
 * The Phase-5 telemetry job needs to tell three failure modes apart so it can
 * react correctly (`docs/architecture.md` → "Inbound (client → server)"):
 *
 * - {@link ActivityWatchUnreachableError} — the request never produced an HTTP
 *   response (connection refused, DNS failure, the SSH forward is down, or the
 *   per-request timeout fired). This is the "host unreachable" case that feeds
 *   the offline-queue / retry path; the client should be probed again later.
 * - {@link ActivityWatchRequestError} — `aw-server` answered with a non-2xx
 *   status. The host is reachable; the request itself failed.
 * - {@link ActivityWatchParseError} — `aw-server` answered 2xx but the body was
 *   not JSON, or did not match the schema we validate against. We never trust
 *   an unvalidated payload (`CLAUDE.md` → "Validate all external input").
 *
 * License boundary: none touched — plain TypeScript, no ActivityWatch code
 * linked (REST-only integration, `docs/licensing-analysis.md`).
 */
import type { z } from "zod";

/** Common base so callers can `instanceof ActivityWatchError` to catch all. */
export class ActivityWatchError extends Error {
  /** Base URL of the `aw-server` the failed request targeted. */
  readonly baseUrl: string;
  /** Request path (relative to {@link baseUrl}) that failed. */
  readonly path: string;

  constructor(baseUrl: string, path: string, message: string) {
    super(message);
    this.name = "ActivityWatchError";
    this.baseUrl = baseUrl;
    this.path = path;
  }
}

/**
 * The request never produced an HTTP response. Carries the underlying `cause`
 * (the error `fetch` threw) and {@link timedOut}, set when the failure was the
 * per-request abort timeout rather than a connection error — both feed the
 * offline-queue / retry path the same way, but the distinction is useful in
 * logs and tests.
 */
export class ActivityWatchUnreachableError extends ActivityWatchError {
  /** True when the per-request timeout aborted the call. */
  readonly timedOut: boolean;

  constructor(baseUrl: string, path: string, cause: unknown, timedOut: boolean) {
    super(
      baseUrl,
      path,
      `ActivityWatch server at ${baseUrl} is unreachable${timedOut ? " (request timed out)" : ""}`,
    );
    // Preserve the originating error without widening this class's typed API.
    super.cause = cause;
    this.name = "ActivityWatchUnreachableError";
    this.timedOut = timedOut;
  }
}

/** `aw-server` answered with a non-2xx status. */
export class ActivityWatchRequestError extends ActivityWatchError {
  /** The HTTP status code returned. */
  readonly statusCode: number;

  constructor(baseUrl: string, path: string, statusCode: number, statusText: string) {
    super(
      baseUrl,
      path,
      `ActivityWatch request to ${path} failed with ${statusCode} ${statusText}`.trimEnd(),
    );
    this.name = "ActivityWatchRequestError";
    this.statusCode = statusCode;
  }
}

/** The response body was not JSON, or did not match the expected schema. */
export class ActivityWatchParseError extends ActivityWatchError {
  /** The zod error when a schema rejected the body; absent for non-JSON. */
  readonly zodError: z.ZodError | undefined;

  constructor(baseUrl: string, path: string, message: string, zodError?: z.ZodError) {
    super(baseUrl, path, `Malformed ActivityWatch response from ${path}: ${message}`);
    this.name = "ActivityWatchParseError";
    this.zodError = zodError;
  }
}
