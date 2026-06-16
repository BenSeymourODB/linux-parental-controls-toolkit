/**
 * The shared `/api/*` error envelope and the error types that render into it.
 *
 * Every error that leaves the JSON API uses one shape so both built-in
 * frontends and external integrators can narrow on it without parsing prose or
 * a stack trace (`CLAUDE.md` → "the single contract for both frontends **and**
 * for external integrations"). We use the small `{ error: { code, message,
 * details } }` form rather than RFC 9457 `problem+json`: it is trivial to type
 * with zod, trivial for the SvelteKit frontend to narrow on, and `details`
 * carries structured zod issues instead of an opaque 500.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

/**
 * One structured problem in an {@link ErrorEnvelope}. For validation failures
 * this is one zod issue: `path` is the dotted location in the rejected input
 * (empty for the root), `code` is zod's issue code (e.g. `invalid_type`).
 */
export const errorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

/** A single structured problem; see {@link errorDetailSchema}. */
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

/** The envelope every `/api/*` error response is serialized as. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    /** Stable, machine-readable code (e.g. `validation_error`, `not_found`). */
    code: z.string(),
    /** Human-readable summary; safe to surface in a UI. */
    message: z.string(),
    /** Present for validation errors; one entry per rejected field. */
    details: z.array(errorDetailSchema).optional(),
  }),
});

/** The inferred shape of an `/api/*` error response. */
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Map a {@link z.ZodError} to the envelope's `details` array — one entry per
 * issue, with the path rendered as a dotted string (`budget.seconds`).
 */
export function zodIssuesToDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * An error a route raises deliberately to produce a specific HTTP status and
 * envelope (e.g. a 404 for a missing policy row, a 409 for a conflict). The
 * `/api` error handler serializes it via {@link toEnvelope}.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: ErrorDetail[] | undefined;

  constructor(statusCode: number, code: string, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /** Render this error as the wire envelope. */
  toEnvelope(): ErrorEnvelope {
    const inner: ErrorEnvelope["error"] = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      inner.details = this.details;
    }
    return { error: inner };
  }
}

/**
 * Raised by the zod validator compiler when a request part fails validation.
 * Carries the originating {@link z.ZodError} so the error handler can render
 * structured `details`; `httpPart` records which part (`body`, `querystring`,
 * …) was rejected. Always maps to HTTP 400.
 */
export class ApiValidationError extends Error {
  readonly statusCode = 400;
  readonly zodError: z.ZodError;
  readonly httpPart: string | undefined;

  constructor(zodError: z.ZodError, httpPart?: string) {
    super(
      httpPart === undefined
        ? "Request validation failed"
        : `Request ${httpPart} failed validation`,
    );
    this.name = "ApiValidationError";
    this.zodError = zodError;
    this.httpPart = httpPart;
  }

  /** The rejected fields as envelope `details`. */
  toDetails(): ErrorDetail[] {
    return zodIssuesToDetails(this.zodError);
  }
}
