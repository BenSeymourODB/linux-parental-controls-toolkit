/**
 * Unit tests for the integration-token guard (#114).
 *
 * The guard is exercised on a throwaway Fastify scope carrying the real `/api`
 * conventions (validator + error envelope) and probe routes — the same pattern
 * `tests/api/validation.test.ts` uses — so the accept/reject/scope behaviour is
 * tested through the exact runtime Fastify uses, including the error envelope.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installApiConventions } from "../../src/api/validation.js";
import { hashToken } from "../../src/auth/secret-token.js";
import { makeRequireIntegrationToken } from "../../src/integrations/guard.js";
import { issueIntegrationToken, revokeIntegrationToken } from "../../src/integrations/tokens.js";
import { findIntegrationTokenByHash } from "../../src/policy/integration-tokens.js";
import { testDb, type TestDb } from "../helpers/db.js";

describe("integration-token guard", () => {
  let app: FastifyInstance;
  let db: TestDb;

  beforeEach(async () => {
    db = testDb();
    app = Fastify({ logger: false });
    installApiConventions(app);
    const guard = makeRequireIntegrationToken(db);

    // Requires a specific scope, and echoes the resolved identity.
    app.get("/needs-grants", { preHandler: guard("grants:write") }, async (request) => ({
      integration: request.integration,
    }));
    // Authentication only, no scope requirement.
    app.get("/needs-auth", { preHandler: guard() }, async (request) => ({
      name: request.integration?.name,
    }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  function bearer(secret: string): { authorization: string } {
    return { authorization: `Bearer ${secret}` };
  }

  it("rejects a missing or malformed Authorization header with 401", async () => {
    expect((await app.inject({ method: "GET", url: "/needs-auth" })).statusCode).toBe(401);
    const malformed = await app.inject({
      method: "GET",
      url: "/needs-auth",
      headers: { authorization: "Basic x" },
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json().error.code).toBe("unauthorized");

    // An empty bearer credential is rejected before any DB lookup.
    const empty = await app.inject({
      method: "GET",
      url: "/needs-auth",
      headers: { authorization: "Bearer " },
    });
    expect(empty.statusCode).toBe(401);
  });

  it("rejects an unknown token with 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/needs-auth",
      headers: bearer("nope"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked token with 401", async () => {
    const issued = issueIntegrationToken(db, { name: "calendar", scopes: ["grants:write"] });
    revokeIntegrationToken(db, issued.id);

    const res = await app.inject({
      method: "GET",
      url: "/needs-auth",
      headers: bearer(issued.secret),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a valid token missing the required scope with 403", async () => {
    const issued = issueIntegrationToken(db, { name: "readonly", scopes: ["policy:read"] });
    const res = await app.inject({
      method: "GET",
      url: "/needs-grants",
      headers: bearer(issued.secret),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("insufficient_scope");

    // The token authenticated (it was validly presented), so `last_used_at` is
    // stamped even though authorization failed — the documented semantics.
    expect(findIntegrationTokenByHash(db, hashToken(issued.secret))?.lastUsedAt).toBeInstanceOf(
      Date,
    );
  });

  it("admits a valid, sufficiently-scoped token and sets request.integration", async () => {
    const issued = issueIntegrationToken(db, {
      name: "calendar",
      scopes: ["grants:write", "policy:read"],
    });
    const res = await app.inject({
      method: "GET",
      url: "/needs-grants",
      headers: bearer(issued.secret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().integration).toEqual({
      id: issued.id,
      name: "calendar",
      scopes: ["grants:write", "policy:read"],
    });
  });

  it("admits any valid token when no scope is required", async () => {
    const issued = issueIntegrationToken(db, { name: "readonly", scopes: ["policy:read"] });
    const res = await app.inject({
      method: "GET",
      url: "/needs-auth",
      headers: bearer(issued.secret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("readonly");
  });

  it("emits no RateLimit-* headers when the guard is built without a limiter", async () => {
    // This suite constructs the guard with no limiter (`makeRequireIntegrationToken(db)`),
    // so throttling is disabled — the documented opt-out. No rate-limit metadata leaks.
    const issued = issueIntegrationToken(db, { name: "readonly", scopes: ["policy:read"] });
    const res = await app.inject({
      method: "GET",
      url: "/needs-auth",
      headers: bearer(issued.secret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
    expect(res.headers["ratelimit-remaining"]).toBeUndefined();
    expect(res.headers["retry-after"]).toBeUndefined();
  });
});
