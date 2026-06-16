/**
 * Unit tests for the zod validator compiler. The error handler, not-found
 * handler, and type-provider inference are exercised end-to-end against a real
 * Fastify instance in `plugin.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiValidationError } from "../../src/api/errors.js";
import { zodValidatorCompiler } from "../../src/api/validation.js";

const schema = z.object({ seconds: z.number().int().positive() });

describe("zodValidatorCompiler", () => {
  it("returns the parsed value for valid input", () => {
    const validate = zodValidatorCompiler({
      schema,
      method: "POST",
      url: "/x",
      httpPart: "body",
    });
    const result = validate({ seconds: 30 });
    expect(result).toEqual({ value: { seconds: 30 } });
  });

  it("returns an ApiValidationError carrying the http part for invalid input", () => {
    const validate = zodValidatorCompiler({
      schema,
      method: "POST",
      url: "/x",
      httpPart: "body",
    });
    const result = validate({ seconds: -1 });
    // Fastify types the result as a wide union; narrow to the error branch.
    if (typeof result !== "object" || result === null || !("error" in result)) {
      throw new Error("expected an error result");
    }
    const error = result.error;
    expect(error).toBeInstanceOf(ApiValidationError);
    if (!(error instanceof ApiValidationError)) throw new Error("expected ApiValidationError");
    expect(error.httpPart).toBe("body");
    expect(error.toDetails()[0]?.path).toBe("seconds");
  });
});
