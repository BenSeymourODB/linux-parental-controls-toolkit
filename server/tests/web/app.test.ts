/**
 * Route tests for the minimal Phase 1 app.
 *
 * Uses Fastify's `app.inject()` — no sockets, no port binding — per
 * docs/testing.md → "HTTP routes".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/web/app.js";

describe("web app routes", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET / returns the placeholder landing page", async () => {
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("hello, no policy yet");
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("GET /healthz reports ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("unknown routes 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });

    expect(res.statusCode).toBe(404);
  });
});
