/**
 * End-to-end tests for the `/api` conventions against a real Fastify instance.
 *
 * The conventions (zod validator compiler, envelope error handler, envelope
 * not-found handler) are installed via the same `installApiConventions` the
 * production plugin uses, then a set of probe routes exercises each path:
 * valid input, validation failure, malformed JSON, a deliberate `ApiError`,
 * an unexpected throw, and an unknown route. `GET /api/meta` is checked
 * through the real `buildApp()` to prove the prefix is mounted.
 *
 * Uses `app.inject()` — no sockets — per docs/testing.md → "HTTP routes".
 */
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiError } from "../../src/api/errors.js";
import { installApiConventions, type ZodTypeProvider } from "../../src/api/validation.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

const bodySchema = z.object({ seconds: z.number().int().positive() });
const querySchema = z.object({ n: z.coerce.number().int() });

/** Mirror of the production plugin plus deliberately-failing probe routes. */
const probePlugin: FastifyPluginAsync = async (scope) => {
  installApiConventions(scope);
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  // Type inference: `request.body.seconds` / `request.query.n` are `number`
  // with no cast — this only compiles because the type provider is applied.
  typed.post("/echo", { schema: { body: bodySchema } }, async (request) => ({
    doubled: request.body.seconds * 2,
  }));
  typed.get("/query", { schema: { querystring: querySchema } }, async (request) => ({
    n: request.query.n,
  }));

  scope.get("/boom-api", async () => {
    throw new ApiError(403, "forbidden", "no entry");
  });
  scope.get("/boom-4xx", async () => {
    // A framework-style 4xx error with no `.code` — exercises the
    // `?? "bad_request"` fallback in the error handler.
    throw Object.assign(new Error("teapot"), { statusCode: 418 });
  });
  scope.get("/boom-500", async () => {
    throw new Error("kaboom");
  });
};

describe("/api conventions", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(probePlugin, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("passes valid input through and infers its type", async () => {
    const res = await app.inject({ method: "POST", url: "/api/echo", payload: { seconds: 30 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ doubled: 60 });
  });

  it("coerces and validates the querystring", async () => {
    const res = await app.inject({ method: "GET", url: "/api/query?n=5" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ n: 5 });
  });

  it("rejects an invalid body with a 400 envelope of structured details", async () => {
    const res = await app.inject({ method: "POST", url: "/api/echo", payload: { seconds: -1 } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("body");
    expect(body.error.details[0].path).toBe("seconds");
    // The response is the envelope, never a stack trace.
    expect(res.body).not.toContain("at ");
  });

  it("rejects malformed JSON with a 400 envelope, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/echo",
      payload: "{ not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error.code).toBe("string");
    expect(typeof res.json().error.message).toBe("string");
  });

  it("maps a thrown ApiError to its status and envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boom-api" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: "forbidden", message: "no entry" } });
  });

  it("passes a code-less 4xx error through as bad_request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boom-4xx" });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: { code: "bad_request", message: "teapot" } });
  });

  it("collapses an unexpected throw to a generic 500 with no leak", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boom-500" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: "internal_error", message: "Internal Server Error" },
    });
    expect(res.body).not.toContain("kaboom");
  });

  it("returns the envelope for an unknown /api route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("GET /api/meta (via buildApp)", () => {
  let harness: TestApp;
  let app: FastifyInstance;

  // buildTestApp() builds the real buildApp() but injects an in-memory db, so
  // the test exercises the actual /api mount without createDb() opening the
  // default /data file (which doesn't exist in CI). Same pattern every other
  // buildApp route test uses.
  beforeEach(() => {
    harness = buildTestApp();
    app = harness.app;
  });

  afterEach(async () => {
    await harness.close();
  });

  it("is mounted and returns the meta DTO", async () => {
    const res = await app.inject({ method: "GET", url: "/api/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "dashboard", apiVersion: 1, eventProtocol: 1 });
  });

  it("serves the /api 404 envelope for unknown api routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("leaves the non-api 404 behaviour unchanged", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    // The default Fastify 404 has `error` as the string "Not Found"; the /api
    // envelope would make it the object `{ code, message }`. Asserting the
    // string proves the /api conventions did not leak outside the prefix.
    expect(res.json().error).toBe("Not Found");
  });
});
