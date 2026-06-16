/**
 * Validation plumbing for the `/api/*` surface: a zod-aware Fastify validator
 * compiler, the error/not-found handlers that render the shared envelope, and
 * a type provider so route handlers infer their input types from zod schemas.
 *
 * These primitives are installed once, inside the encapsulated `/api` plugin
 * (see `plugin.ts`), so the conventions never leak onto `/`, `/healthz`,
 * `/admin`, or `/app`. They are also exported individually so tests can wire
 * them onto a throwaway scope with probe routes and exercise the exact runtime
 * Fastify uses.
 *
 * Why no `fastify-type-provider-zod` dependency: the only thing that library
 * adds over the few lines here is the same `FastifyTypeProvider` mapping plus
 * a serializer compiler we do not want (we keep response shaping at the TS/DTO
 * level, not runtime JSON-schema serialization). zod + Fastify's own
 * type-provider hook already cover the inference we need.
 *
 * License boundary: none touched — plain TypeScript + zod + Fastify.
 */
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifySchemaCompiler,
  FastifyTypeProvider,
} from "fastify";
import { z } from "zod";

import { ApiError, ApiValidationError, type ErrorEnvelope } from "./errors.js";

/**
 * Fastify type provider that infers a route's `body`/`querystring`/`params`/
 * `headers` types from the zod schema declared for that part, so handlers read
 * `request.body` as `z.infer<typeof bodySchema>` with no `as` cast. Apply it
 * per scope with `scope.withTypeProvider<ZodTypeProvider>()` before declaring
 * routes.
 */
export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends z.ZodType ? z.output<this["schema"]> : unknown;
  serializer: this["schema"] extends z.ZodType ? z.input<this["schema"]> : unknown;
}

/**
 * Validator compiler that treats each route-part `schema` as a zod schema and
 * runs `safeParse`. On success Fastify replaces the request part with the
 * parsed (and coerced/defaulted) value; on failure it throws the returned
 * {@link ApiValidationError}, which the error handler maps to a 400 envelope.
 */
export const zodValidatorCompiler: FastifySchemaCompiler<z.ZodType> =
  ({ schema, httpPart }) =>
  (data: unknown) => {
    const result = schema.safeParse(data);
    if (result.success) {
      return { value: result.data };
    }
    return { error: new ApiValidationError(result.error, httpPart) };
  };

/**
 * Error handler for the `/api` scope. Maps our own error types to their
 * envelope, passes through framework 4xx client errors (e.g. malformed JSON)
 * as a 400-class envelope, and collapses anything unexpected to a generic 500
 * that leaks neither message nor stack — the real error is logged instead.
 */
export function apiErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof ApiValidationError) {
    const envelope: ErrorEnvelope = {
      error: { code: "validation_error", message: error.message, details: error.toDetails() },
    };
    reply.code(400).send(envelope);
    return;
  }

  if (error instanceof ApiError) {
    reply.code(error.statusCode).send(error.toEnvelope());
    return;
  }

  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    // A framework client error (bad JSON, unsupported media type, …). Its
    // message is about the request, so it is safe to surface.
    const envelope: ErrorEnvelope = {
      error: { code: error.code ?? "bad_request", message: error.message },
    };
    reply.code(status).send(envelope);
    return;
  }

  // Unexpected: log the real error (with stack) and return a generic envelope.
  request.log.error({ err: error }, "unhandled API error");
  const envelope: ErrorEnvelope = {
    error: { code: "internal_error", message: "Internal Server Error" },
  };
  reply.code(500).send(envelope);
}

/** Not-found handler for the `/api` scope: a 404 in the shared envelope. */
export function apiNotFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  const envelope: ErrorEnvelope = {
    error: {
      code: "not_found",
      message: `Route ${request.method} ${request.url} not found`,
    },
  };
  reply.code(404).send(envelope);
}

/**
 * Install the `/api` conventions on a scope: the zod validator compiler, the
 * envelope error handler, and the envelope not-found handler. Encapsulated to
 * the scope it is called on, so it does not affect routes outside `/api`.
 */
export function installApiConventions(scope: FastifyInstance): void {
  scope.setValidatorCompiler(zodValidatorCompiler);
  scope.setErrorHandler(apiErrorHandler);
  scope.setNotFoundHandler(apiNotFoundHandler);
}
