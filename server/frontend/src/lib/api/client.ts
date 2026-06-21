/**
 * The typed `/api` fetch wrapper shared by every admin call (#53).
 *
 * All requests are same-origin (Fastify serves both `/admin` and `/api`), so
 * the signed admin session cookie rides along automatically. Responses are
 * narrowed against the shared error envelope (`server/src/api/errors.ts`): a
 * non-2xx response is turned into a typed {@link ApiError} carrying the
 * machine-readable `code`, a UI-safe `message`, and any validation `details`.
 *
 * A `401` is surfaced distinctly via `error.unauthorized` so the app shell can
 * drop straight to the login view instead of rendering a generic error — the
 * client-side counterpart of the server's `requireAdmin` guard.
 *
 * License boundary: none — plain browser `fetch` over the JSON API.
 */
import type { ErrorDetail, ErrorEnvelope } from "./contract.js";

/** Base path of the JSON API. Same-origin with the `/admin` surface. */
const API_BASE = "/api";

/**
 * An error raised when an `/api` call returns a non-2xx response (or the
 * response body is not the expected JSON). Mirrors the server error envelope
 * so callers can branch on a stable `code` rather than parsing prose.
 */
export class ApiError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Stable, machine-readable code from the envelope (e.g. `not_found`). */
  readonly code: string;
  /** Per-field validation problems, when the server supplied them. */
  readonly details: ErrorDetail[];

  constructor(status: number, code: string, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the failure was an authentication failure (`401`). */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

/** Narrow an unknown JSON value to the shared error envelope shape. */
function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const inner = (value as { error: unknown }).error;
  return (
    typeof inner === "object" &&
    inner !== null &&
    typeof (inner as { code?: unknown }).code === "string" &&
    typeof (inner as { message?: unknown }).message === "string"
  );
}

/** Options for {@link apiFetch}. `body` is JSON-encoded when present. */
export interface ApiFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Request body; serialized as JSON with the matching `Content-Type`. */
  body?: unknown;
  /** Optional override of the global `fetch` (used by tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Issue a JSON request to `/api{path}` and return the parsed response body.
 *
 * Throws {@link ApiError} on any non-2xx status (decoded from the envelope when
 * present, otherwise synthesised from the status). `204 No Content` and empty
 * bodies resolve to `undefined`, so a `DELETE` can be typed as
 * `apiFetch<void>(...)`.
 *
 * @typeParam T - the expected (already validated, server-side) response shape.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = "GET", body, fetchImpl = fetch } = options;

  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const response = await fetchImpl(`${API_BASE}${path}`, init);

  // Read the body once; tolerate an empty/non-JSON body (e.g. 204).
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? undefined : safeJsonParse(text);

  if (!response.ok) {
    if (isErrorEnvelope(parsed)) {
      throw new ApiError(
        response.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.details ?? [],
      );
    }
    throw new ApiError(response.status, "http_error", `Request failed (${response.status})`);
  }

  return parsed as T;
}

/** Parse JSON, returning `undefined` rather than throwing on malformed input. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
