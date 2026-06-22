/**
 * Unit tests for the shared `Authorization: Bearer` header parser
 * (`auth/bearer.ts`), relocated here from the enrolment-route tests when the
 * parser moved out of `api/clients/routes.ts` so the integration guard (#114)
 * could share it without a backwards dependency.
 */
import { describe, expect, it } from "vitest";

import { parseBearer } from "../../src/auth/bearer.js";

describe("parseBearer", () => {
  it("extracts a bearer token, and rejects missing/malformed/empty headers", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Basic abc123")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
    expect(parseBearer("Bearer    ")).toBeNull();
  });
});
