/**
 * Unit tests for the shared `404 not_found` assertion helpers (#224):
 * `notFound`, `assertFound`, and `assertRemoved`, extracted from the policy
 * CRUD routes so the 404 status/code/message contract lives in one place. The
 * `app.inject` route tests in `policy.test.ts` already exercise these helpers
 * end-to-end at every check site (they assert status + code); these tests pin
 * the exact envelope a helper produces — including the message text the route
 * tests don't assert — so a future change to the 404 shape is caught here.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "../../src/api/errors.js";
import { assertFound, assertRemoved, notFound } from "../../src/api/policy/routes.js";

describe("notFound", () => {
  it("builds a 404 not_found ApiError carrying the message", () => {
    const err = notFound("nope");
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("nope");
    expect(err.details).toBeUndefined();
  });
});

describe("assertFound", () => {
  it("returns the row unchanged when present", () => {
    const row = { id: 7, name: "alice" };
    expect(assertFound(row, "User", 7)).toBe(row);
  });

  it("returns falsy-but-defined rows (0, empty string, false) rather than 404ing", () => {
    // The guard is `=== undefined`, so a row that is legitimately falsy still
    // passes — only a missing row 404s.
    expect(assertFound(0, "User", 1)).toBe(0);
    expect(assertFound("", "User", 1)).toBe("");
    expect(assertFound(false, "User", 1)).toBe(false);
  });

  it("throws a 404 not_found naming the entity and id when undefined", () => {
    try {
      assertFound(undefined, "Budget", 42);
      expect.unreachable("assertFound should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(404);
      expect(apiErr.code).toBe("not_found");
      expect(apiErr.message).toBe("Budget 42 not found");
    }
  });
});

describe("assertRemoved", () => {
  it("is a no-op when the removal reported a row was deleted", () => {
    expect(() => {
      assertRemoved(true, "should not throw");
    }).not.toThrow();
  });

  it("throws a 404 not_found with the supplied message when nothing was removed", () => {
    try {
      assertRemoved(false, "No link between user 1 and client 2");
      expect.unreachable("assertRemoved should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(404);
      expect(apiErr.code).toBe("not_found");
      expect(apiErr.message).toBe("No link between user 1 and client 2");
    }
  });
});
