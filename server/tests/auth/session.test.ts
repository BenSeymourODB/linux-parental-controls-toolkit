/**
 * Unit tests for the signed session cookie helpers (#52).
 *
 * Exercises the real `@fastify/cookie` signing path through a throwaway Fastify
 * instance with `/set`, `/read`, and `/clear` probe routes, so the tests cover
 * issue → read round-trips, tamper rejection, and TTL expiry exactly as the
 * runtime behaves.
 */
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearSession,
  issueSession,
  readSession,
} from "../../src/auth/session.js";

/** Build an app with the cookie plugin and probe routes over the session helpers. */
async function buildCookieApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: "session-test-secret" });
  app.post("/set", async (_request, reply) => {
    issueSession(reply, "alice");
    return { ok: true };
  });
  app.get("/read", async (request) => ({ session: readSession(request) }));
  // Sets a *validly signed* cookie whose payload is not the expected JSON, so
  // the decode step (not the signature check) is what rejects it.
  app.post("/set-raw", async (_request, reply) => {
    reply.setCookie(SESSION_COOKIE, "not-base64url-json!!", { signed: true, path: "/" });
    return { ok: true };
  });
  app.post("/clear", async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });
  await app.ready();
  return app;
}

/** The wire form of the session cookie (`pct_session=<signed>`) from a Set-Cookie header. */
function sessionCookieHeader(setCookie: string | string[] | undefined): string {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie in Set-Cookie");
  return match.split(";")[0] ?? "";
}

describe("session cookie", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildCookieApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("issues a signed, httpOnly, SameSite=Strict session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/set" });
    const raw = res.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it("round-trips: a freshly issued cookie reads back as the session", async () => {
    const setRes = await app.inject({ method: "POST", url: "/set" });
    const cookieHeader = sessionCookieHeader(setRes.headers["set-cookie"]);

    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: cookieHeader },
    });
    expect(readRes.json().session).toMatchObject({ sub: "alice" });
  });

  it("reads back null when no cookie is present", async () => {
    const res = await app.inject({ method: "GET", url: "/read" });
    expect(res.json().session).toBeNull();
  });

  it("rejects a tampered cookie value", async () => {
    const setRes = await app.inject({ method: "POST", url: "/set" });
    const header = sessionCookieHeader(setRes.headers["set-cookie"]);
    // Flip the last character of the signed value to break the signature.
    const tampered = header.slice(0, -1) + (header.endsWith("a") ? "b" : "a");

    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: tampered },
    });
    expect(readRes.json().session).toBeNull();
  });

  it("rejects an unsigned / garbage cookie", async () => {
    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: `${SESSION_COOKIE}=garbage` },
    });
    expect(readRes.json().session).toBeNull();
  });

  it("rejects a validly-signed cookie whose payload is not the expected JSON", async () => {
    const setRes = await app.inject({ method: "POST", url: "/set-raw" });
    const cookieHeader = sessionCookieHeader(setRes.headers["set-cookie"]);
    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: cookieHeader },
    });
    expect(readRes.json().session).toBeNull();
  });

  it("rejects a cookie whose iat is older than the TTL", async () => {
    const base = 1_700_000_000_000; // fixed epoch ms
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    const setRes = await app.inject({ method: "POST", url: "/set" });
    const cookieHeader = sessionCookieHeader(setRes.headers["set-cookie"]);

    // Advance past the TTL: the signature is still valid, but readSession
    // must reject it on age.
    nowSpy.mockReturnValue(base + (SESSION_TTL_SECONDS + 10) * 1000);
    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: cookieHeader },
    });
    expect(readRes.json().session).toBeNull();
  });

  it("clears the session cookie on logout", async () => {
    const res = await app.inject({ method: "POST", url: "/clear" });
    const raw = res.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
    expect(header).toContain(`${SESSION_COOKIE}=`);
    // Cleared cookies expire immediately (Max-Age=0 or a past Expires).
    expect(header).toMatch(/Max-Age=0|Expires=/i);
  });
});
