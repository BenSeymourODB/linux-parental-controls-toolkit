/**
 * End-to-end tests for the auth routes and guard (#52), driven through real
 * Fastify instances with `app.inject()` (no sockets) — per docs/testing.md →
 * "HTTP routes".
 *
 * Covers login success/failure, the session endpoint, logout, rate limiting,
 * the unconfigured (`503`) path, and the reusable `requireAdmin` guard.
 */
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAuth } from "../../src/auth/index.js";
import { SESSION_COOKIE } from "../../src/auth/session.js";
import { installApiConventions } from "../../src/api/validation.js";
import { loadSettings } from "../../src/config.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { testDb, type TestDb } from "../helpers/db.js";

/** Settings with a secret and a seeded admin (`ben` / `hunter2`). */
function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "auth-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

/** Extract the `pct_session=<signed>` wire cookie from a login response. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

describe("auth routes (configured, admin seeded)", () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready(); // triggers the first-admin bootstrap
  });

  afterEach(async () => {
    await harness.close();
  });

  it("logs in with correct credentials and sets a session cookie", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: true, username: "ben" });
    expect(sessionCookie(res)).toContain(`${SESSION_COOKIE}=`);
  });

  it("rejects a wrong password with a 401 envelope and no cookie", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "nope" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects an unknown username with the same 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "hunter2" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
  });

  it("rejects a malformed body with a 400 validation envelope", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("reports an anonymous session as unauthenticated", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/auth/session" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: false });
  });

  it("reports the logged-in session when the cookie is presented", async () => {
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: sessionCookie(login) },
    });
    expect(res.json()).toEqual({ authenticated: true, username: "ben" });
  });

  it("logs out, clearing the session cookie", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: false });
    const raw = res.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
    expect(header).toContain(`${SESSION_COOKIE}=`);
  });

  it("rate-limits repeated failed logins with a 429", async () => {
    for (let i = 0; i < 5; i += 1) {
      const fail = await harness.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "ben", password: "wrong" },
      });
      expect(fail.statusCode).toBe(401);
    }
    const blocked = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("too_many_requests");
  });
});

describe("auth routes (unconfigured — no PCT_SECRET_KEY)", () => {
  let harness: TestApp;

  beforeEach(async () => {
    // No PCT_SECRET_KEY: sessions cannot be signed, so auth fails closed.
    const settings = loadSettings({
      PCT_LOG_LEVEL: "silent",
      PCT_ADMIN_USERNAME: "ben",
      PCT_ADMIN_PASSWORD: "hunter2",
    });
    harness = buildTestApp({ appOptions: { settings } });
    await harness.app.ready();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("returns 503 auth_not_configured for login", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_not_configured");
  });

  it("returns 503 for the session endpoint", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/auth/session" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_not_configured");
  });

  it("still allows logout (no secret needed to clear a cookie)", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: false });
  });
});

/** A plugin that wires auth and a probe route behind the `requireAdmin` guard. */
const guardedApi: FastifyPluginAsync<{ settings: ReturnType<typeof configuredSettings> }> = async (
  scope,
  opts,
) => {
  installApiConventions(scope);
  await registerAuth(scope, opts.settings);
  scope.get("/protected", { preHandler: scope.requireAdmin }, async (request) => ({
    username: request.admin?.username,
  }));
};

describe("requireAdmin guard", () => {
  let app: FastifyInstance;
  let db: TestDb;

  beforeEach(async () => {
    db = testDb();
    app = Fastify({ logger: false });
    app.decorate("db", db);
    await app.register(guardedApi, { prefix: "/api", settings: configuredSettings() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  it("rejects an anonymous request with a 401 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/protected" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("allows a request carrying a valid admin session", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie: sessionCookie(login) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: "ben" });
  });
});
