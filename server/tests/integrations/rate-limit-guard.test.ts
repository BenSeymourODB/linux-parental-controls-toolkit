/**
 * Integration tests for per-token rate limiting in the integration guard (#115).
 *
 * Driven through the exact runtime Fastify uses (validator + shared error
 * envelope + a probe route), like `guard.test.ts`, but with a
 * {@link FixedWindowQuota} injected into the guard on a hand-cranked clock — so
 * the throttle, the `429 rate_limited` envelope, the `RateLimit-*` /
 * `Retry-After` headers, per-token isolation, and the window reset are all
 * exercised without real time.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installApiConventions } from "../../src/api/validation.js";
import { makeRequireIntegrationToken } from "../../src/integrations/guard.js";
import { FixedWindowQuota } from "../../src/integrations/rate-limit.js";
import { issueIntegrationToken } from "../../src/integrations/tokens.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("integration guard — per-token rate limiting (#115)", () => {
  let app: FastifyInstance;
  let db: TestDb;
  let nowMs: number;

  beforeEach(async () => {
    db = testDb();
    nowMs = 10_000;
    app = Fastify({ logger: false });
    installApiConventions(app);

    // Two requests per 60 s window, on the injected clock.
    const limiter = new FixedWindowQuota({
      maxRequests: 2,
      windowMs: 60_000,
      now: () => nowMs,
    });
    const guard = makeRequireIntegrationToken(db, limiter);

    app.get("/ping", { preHandler: guard() }, async (request) => ({
      id: request.integration?.id,
    }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  function ping(secret: string) {
    return app.inject({
      method: "GET",
      url: "/ping",
      headers: { authorization: `Bearer ${secret}` },
    });
  }

  it("admits up to the limit, annotates every response, then rejects 429", async () => {
    const token = issueIntegrationToken(db, { name: "calendar", scopes: ["policy:read"] });

    const first = await ping(token.secret);
    expect(first.statusCode).toBe(200);
    expect(first.headers["ratelimit-limit"]).toBe("2");
    expect(first.headers["ratelimit-remaining"]).toBe("1");
    expect(first.headers["ratelimit-reset"]).toBe("60");

    const second = await ping(token.secret);
    expect(second.statusCode).toBe(200);
    expect(second.headers["ratelimit-remaining"]).toBe("0");

    const third = await ping(token.secret);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
    expect(third.headers["retry-after"]).toBe("60");
    expect(third.headers["ratelimit-remaining"]).toBe("0");
  });

  it("keeps each token's budget independent", async () => {
    const a = issueIntegrationToken(db, { name: "a", scopes: ["policy:read"] });
    const b = issueIntegrationToken(db, { name: "b", scopes: ["policy:read"] });

    await ping(a.secret);
    await ping(a.secret);
    expect((await ping(a.secret)).statusCode).toBe(429);

    // A different token is unaffected by the first's exhaustion.
    expect((await ping(b.secret)).statusCode).toBe(200);
  });

  it("admits again once the window elapses", async () => {
    const token = issueIntegrationToken(db, { name: "calendar", scopes: ["policy:read"] });

    await ping(token.secret);
    await ping(token.secret);
    expect((await ping(token.secret)).statusCode).toBe(429);

    // Advance past the window boundary → the token recovers its full budget.
    nowMs += 60_000;
    const afterReset = await ping(token.secret);
    expect(afterReset.statusCode).toBe(200);
    expect(afterReset.headers["ratelimit-remaining"]).toBe("1");
  });

  it("does not spend a token's budget on an unauthenticated request", async () => {
    const token = issueIntegrationToken(db, { name: "calendar", scopes: ["policy:read"] });

    // Anonymous hits are 401 before any token is known — they must not count.
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(401);
    }

    // The token still has its full budget.
    expect((await ping(token.secret)).statusCode).toBe(200);
    expect((await ping(token.secret)).statusCode).toBe(200);
    expect((await ping(token.secret)).statusCode).toBe(429);
  });
});
