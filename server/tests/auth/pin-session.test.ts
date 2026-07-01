/**
 * Unit tests for the signed per-user PIN-session cookie helpers (#112).
 *
 * Mirrors `tests/auth/session.test.ts`: a throwaway Fastify instance with
 * `@fastify/cookie` and probe routes exercises the real signing path, so the
 * tests cover issue → read round-trips, tamper rejection, and TTL expiry as the
 * runtime behaves. The PIN cookie is a distinct name with a shorter TTL.
 */
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PIN_SESSION_COOKIE,
  PIN_SESSION_TTL_SECONDS,
  clearPinSession,
  issuePinSession,
  readPinSession,
} from "../../src/auth/pin-session.js";

async function buildCookieApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: "pin-session-test-secret" });
  app.post("/set", async (_request, reply) => {
    issuePinSession(reply, 7);
    return { ok: true };
  });
  app.get("/read", async (request) => ({ session: readPinSession(request) }));
  app.post("/set-raw", async (_request, reply) => {
    reply.setCookie(PIN_SESSION_COOKIE, "not-base64url-json!!", { signed: true, path: "/" });
    return { ok: true };
  });
  app.post("/clear", async (_request, reply) => {
    clearPinSession(reply);
    return { ok: true };
  });
  await app.ready();
  return app;
}

function pinCookieHeader(setCookie: string | string[] | undefined): string {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const match = headers.find((h) => h.startsWith(`${PIN_SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no PIN cookie in Set-Cookie");
  return match.split(";")[0] ?? "";
}

describe("PIN session cookie", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildCookieApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("issues a signed, httpOnly, SameSite=Strict cookie with the 12h TTL", async () => {
    const res = await app.inject({ method: "POST", url: "/set" });
    const raw = res.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
    expect(header).toContain(`${PIN_SESSION_COOKIE}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${PIN_SESSION_TTL_SECONDS}`);
  });

  it("round-trips: a freshly issued cookie reads back as the PIN session", async () => {
    const setRes = await app.inject({ method: "POST", url: "/set" });
    const cookieHeader = pinCookieHeader(setRes.headers["set-cookie"]);
    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: cookieHeader },
    });
    expect(readRes.json().session).toMatchObject({ uid: 7 });
  });

  it("reads back null when no cookie is present", async () => {
    const res = await app.inject({ method: "GET", url: "/read" });
    expect(res.json().session).toBeNull();
  });

  it("rejects a tampered cookie value", async () => {
    const setRes = await app.inject({ method: "POST", url: "/set" });
    const header = pinCookieHeader(setRes.headers["set-cookie"]);
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
      headers: { cookie: `${PIN_SESSION_COOKIE}=garbage` },
    });
    expect(readRes.json().session).toBeNull();
  });

  it("rejects a validly-signed cookie whose payload is not the expected JSON", async () => {
    const setRes = await app.inject({ method: "POST", url: "/set-raw" });
    const cookieHeader = pinCookieHeader(setRes.headers["set-cookie"]);
    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: cookieHeader },
    });
    expect(readRes.json().session).toBeNull();
  });

  it("rejects a cookie whose iat is older than the TTL", async () => {
    const base = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    const setRes = await app.inject({ method: "POST", url: "/set" });
    const cookieHeader = pinCookieHeader(setRes.headers["set-cookie"]);

    nowSpy.mockReturnValue(base + (PIN_SESSION_TTL_SECONDS + 10) * 1000);
    const readRes = await app.inject({
      method: "GET",
      url: "/read",
      headers: { cookie: cookieHeader },
    });
    expect(readRes.json().session).toBeNull();
  });

  it("clears the PIN cookie on logout", async () => {
    const res = await app.inject({ method: "POST", url: "/clear" });
    const raw = res.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
    expect(header).toContain(`${PIN_SESSION_COOKIE}=`);
    expect(header).toMatch(/Max-Age=0|Expires=/i);
  });
});
