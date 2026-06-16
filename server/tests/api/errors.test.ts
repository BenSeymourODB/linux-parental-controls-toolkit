/**
 * Unit tests for the shared `/api` error envelope and error types.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ApiError,
  ApiValidationError,
  errorEnvelopeSchema,
  zodIssuesToDetails,
} from "../../src/api/errors.js";

describe("errorEnvelopeSchema", () => {
  it("accepts an envelope with details", () => {
    const parsed = errorEnvelopeSchema.parse({
      error: {
        code: "validation_error",
        message: "Request body failed validation",
        details: [{ path: "seconds", message: "Expected number", code: "invalid_type" }],
      },
    });
    expect(parsed.error.details).toHaveLength(1);
  });

  it("accepts an envelope without details", () => {
    const parsed = errorEnvelopeSchema.parse({
      error: { code: "not_found", message: "nope" },
    });
    expect(parsed.error.details).toBeUndefined();
  });

  it("rejects a payload missing the error code", () => {
    const result = errorEnvelopeSchema.safeParse({ error: { message: "x" } });
    expect(result.success).toBe(false);
  });
});

describe("zodIssuesToDetails", () => {
  it("renders each issue as a dotted-path detail", () => {
    const schema = z.object({ budget: z.object({ seconds: z.number() }) });
    const result = schema.safeParse({ budget: { seconds: "nope" } });
    expect(result.success).toBe(false);
    if (result.success) return;

    const details = zodIssuesToDetails(result.error);
    expect(details).toEqual([
      { path: "budget.seconds", message: expect.any(String), code: "invalid_type" },
    ]);
  });

  it("renders a root-level issue with an empty path", () => {
    const result = z.string().safeParse(42);
    expect(result.success).toBe(false);
    if (result.success) return;

    const [detail] = zodIssuesToDetails(result.error);
    expect(detail?.path).toBe("");
  });
});

describe("ApiError", () => {
  it("carries status/code and renders an envelope without details", () => {
    const err = new ApiError(404, "not_found", "User not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.toEnvelope()).toEqual({
      error: { code: "not_found", message: "User not found" },
    });
  });

  it("includes details in the envelope when provided", () => {
    const err = new ApiError(409, "conflict", "Already exists", [
      { path: "name", message: "taken" },
    ]);
    expect(err.toEnvelope().error.details).toEqual([{ path: "name", message: "taken" }]);
  });
});

describe("ApiValidationError", () => {
  it("is a 400 and names the rejected http part", () => {
    const result = z.object({ a: z.number() }).safeParse({ a: "x" });
    expect(result.success).toBe(false);
    if (result.success) return;

    const err = new ApiValidationError(result.error, "body");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("Request body failed validation");
    expect(err.toDetails()).toHaveLength(1);
  });

  it("falls back to a generic message when the part is unknown", () => {
    const result = z.number().safeParse("x");
    expect(result.success).toBe(false);
    if (result.success) return;

    const err = new ApiValidationError(result.error);
    expect(err.message).toBe("Request validation failed");
    expect(err.httpPart).toBeUndefined();
  });
});
