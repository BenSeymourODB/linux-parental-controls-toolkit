/**
 * Error taxonomy for the AdGuard Home REST client.
 *
 * The dashboard talks to AdGuard Home only over its `/control/*` REST API in
 * both `managed` and `external` modes (`docs/server-deployment.md` → "License
 * posture is identical in both modes"). The client surfaces every failure as
 * one of these typed errors so callers can branch without parsing prose:
 *
 * - {@link AdGuardUnreachableError} — the request never produced an HTTP
 *   response (connection refused, DNS failure, the instance is down, or the
 *   per-request timeout fired). For the `external` preflight (#95) this is the
 *   "your configured AdGuard URL isn't answering" case.
 * - {@link AdGuardRequestError} — AdGuard answered with a non-2xx status. The
 *   host is reachable; the request itself failed.
 * - {@link AdGuardAuthError} — a 401/403 specifically (a subclass of
 *   {@link AdGuardRequestError}, so a broad `instanceof AdGuardRequestError`
 *   still catches it; `docs/testing.md` → "401 Unauthorized — rejects with
 *   `AuthError`"). The dedicated AdGuard account's credentials are wrong or
 *   lack permission.
 * - {@link AdGuardParseError} — AdGuard answered 2xx but the body was not JSON,
 *   or did not match the schema we validate against. We never trust an
 *   unvalidated payload (`CLAUDE.md` → "Validate all external input").
 * - {@link AdGuardScopeError} — a write was attempted against a client name
 *   outside the dashboard's `pct:`-prefixed namespace. Raised *before* any
 *   request so the dashboard can never edit a client it does not own
 *   (`docs/server-deployment.md` → "What the dashboard expects from an external
 *   instance").
 * - {@link AdGuardConfigError} — a configured credential file
 *   (`PCT_ADGUARD_PASSWORD_FILE` / `PCT_ADGUARD_API_TOKEN_FILE`) could not be
 *   read while resolving the dedicated AdGuard account's credentials (#95).
 *   Distinct from the request-time errors above: it is raised before any client
 *   is constructed, so it carries the offending file path rather than a base
 *   URL + request path.
 *
 * License boundary: none touched — plain TypeScript, no AdGuard code linked
 * (REST-only integration, `docs/licensing-analysis.md`).
 */
import type { z } from "zod";

/** Common base so callers can `instanceof AdGuardError` to catch all. */
export class AdGuardError extends Error {
  /** Base URL of the AdGuard instance the failed operation targeted. */
  readonly baseUrl: string;
  /** Request path (relative to {@link baseUrl}) the operation targeted. */
  readonly path: string;

  constructor(baseUrl: string, path: string, message: string) {
    super(message);
    this.name = "AdGuardError";
    this.baseUrl = baseUrl;
    this.path = path;
  }
}

/**
 * The request never produced an HTTP response. Carries the underlying `cause`
 * (the error `fetch` threw) and {@link timedOut}, set when the failure was the
 * per-request abort timeout rather than a connection error.
 */
export class AdGuardUnreachableError extends AdGuardError {
  /** True when the per-request timeout aborted the call. */
  readonly timedOut: boolean;

  constructor(baseUrl: string, path: string, cause: unknown, timedOut: boolean) {
    super(
      baseUrl,
      path,
      `AdGuard Home at ${baseUrl} is unreachable${timedOut ? " (request timed out)" : ""}`,
    );
    // Preserve the originating error without widening this class's typed API.
    super.cause = cause;
    this.name = "AdGuardUnreachableError";
    this.timedOut = timedOut;
  }
}

/** AdGuard answered with a non-2xx status. */
export class AdGuardRequestError extends AdGuardError {
  /** The HTTP status code returned. */
  readonly statusCode: number;

  constructor(baseUrl: string, path: string, statusCode: number, statusText: string) {
    super(
      baseUrl,
      path,
      `AdGuard request to ${path} failed with ${statusCode} ${statusText}`.trimEnd(),
    );
    this.name = "AdGuardRequestError";
    this.statusCode = statusCode;
  }
}

/**
 * A 401/403: the dedicated AdGuard account's credentials are missing, wrong, or
 * insufficient. A subclass of {@link AdGuardRequestError} so callers that only
 * care about "the request failed" still catch it, while the preflight/auth path
 * can single it out.
 */
export class AdGuardAuthError extends AdGuardRequestError {
  constructor(baseUrl: string, path: string, statusCode: number, statusText: string) {
    super(baseUrl, path, statusCode, statusText);
    this.name = "AdGuardAuthError";
  }
}

/** The response body was not JSON, or did not match the expected schema. */
export class AdGuardParseError extends AdGuardError {
  /** The zod error when a schema rejected the body; absent for non-JSON. */
  readonly zodError: z.ZodError | undefined;

  constructor(baseUrl: string, path: string, message: string, zodError?: z.ZodError) {
    super(baseUrl, path, `Malformed AdGuard response from ${path}: ${message}`);
    this.name = "AdGuardParseError";
    this.zodError = zodError;
  }
}

/**
 * A write was attempted against a client name outside the dashboard's
 * `pct:`-prefixed namespace. Raised before any HTTP request is issued, so the
 * dashboard structurally cannot mutate a client a household configured itself.
 */
export class AdGuardScopeError extends AdGuardError {
  /** The offending client name. */
  readonly clientName: string;
  /** The required prefix the name failed to carry. */
  readonly requiredPrefix: string;

  constructor(baseUrl: string, path: string, clientName: string, requiredPrefix: string) {
    super(
      baseUrl,
      path,
      `Refusing to write AdGuard client ${JSON.stringify(clientName)}: ` +
        `the dashboard only manages clients prefixed ${JSON.stringify(requiredPrefix)}`,
    );
    this.name = "AdGuardScopeError";
    this.clientName = clientName;
    this.requiredPrefix = requiredPrefix;
  }
}

/**
 * A configured AdGuard credential file could not be read while resolving the
 * dedicated account's credentials (#95). Raised before any {@link AdGuardError}
 * is possible — there is no base URL or request path yet — so it stands apart
 * from the request-time taxonomy and carries the offending file {@link path}
 * and the originating error as {@link Error.cause}.
 */
export class AdGuardConfigError extends Error {
  /** The credential file path that could not be read. */
  readonly path: string;

  constructor(path: string, message: string, cause?: unknown) {
    super(message);
    this.name = "AdGuardConfigError";
    this.path = path;
    if (cause !== undefined) this.cause = cause;
  }
}
