/**
 * HTTP tests for the per-user PIN auth routes (#112), driven through the real
 * app via `app.inject()`.
 *
 * Covers admin PIN management (`PUT`/`DELETE`/`GET /api/users/:userId/pin`,
 * admin-guarded, 404s, validation), the `/app` child session
 * (`POST`/`DELETE`/`GET /api/app/session` — login ok/wrong/unknown/no-PIN, the
 * per-user lockout, whoami), and the own-data `GET /api/app/me` with its
 * deny-by-default scoping: a PIN session reaches `/app/me` but **not** an admin
 * route, and an admin session does **not** reach `/app/me`.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PIN_SESSION_COOKIE } from "../../src/auth/pin-session.js";
import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "app-pin-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

/** Pull a named cookie's `name=value` pair out of a response's set-cookie header. */
function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no ${name} cookie set`);
  return match.split(";")[0] ?? "";
}

/** Whether a response clears the named cookie (sets it with an empty value). */
function clearsCookie(res: { headers: Record<string, unknown> }, name: string): boolean {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  // clearCookie emits an empty value with an immediate expiry, e.g. `name=; Max-Age=0`.
  return headers.some((h) => h.startsWith(`${name}=;`));
}

describe("per-user PIN auth routes", () => {
  let harness: TestApp;
  let adminCookie: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    adminCookie = cookieFrom(login, SESSION_COOKIE);
  });

  afterEach(async () => {
    await harness.close();
  });

  function asAdmin(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie: adminCookie } });
  }

  async function createUser(displayName: string, tz?: string): Promise<number> {
    const res = await asAdmin({
      method: "POST",
      url: "/api/users",
      payload: tz === undefined ? { displayName } : { displayName, tz },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  async function setPin(userId: number, pin: string) {
    return asAdmin({ method: "PUT", url: `/api/users/${userId}/pin`, payload: { pin } });
  }

  // --- Admin PIN management -------------------------------------------------

  it("sets, reports, and clears a user's PIN (admin)", async () => {
    const userId = await createUser("Alice");

    expect((await asAdmin({ method: "GET", url: `/api/users/${userId}/pin` })).json()).toEqual({
      pinSet: false,
    });

    const set = await setPin(userId, "1234");
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ pinSet: true });

    expect((await asAdmin({ method: "GET", url: `/api/users/${userId}/pin` })).json()).toEqual({
      pinSet: true,
    });

    const del = await asAdmin({ method: "DELETE", url: `/api/users/${userId}/pin` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ pinSet: false });

    // Clearing again is idempotent.
    const del2 = await asAdmin({ method: "DELETE", url: `/api/users/${userId}/pin` });
    expect(del2.statusCode).toBe(200);
    expect(del2.json()).toEqual({ pinSet: false });
  });

  it("rejects a malformed PIN with a 400", async () => {
    const userId = await createUser("Alice");
    for (const bad of ["abc", "12", "123456789012", "12 34"]) {
      const res = await setPin(userId, bad);
      expect(res.statusCode).toBe(400);
    }
    // None of those took effect.
    expect((await asAdmin({ method: "GET", url: `/api/users/${userId}/pin` })).json()).toEqual({
      pinSet: false,
    });
  });

  it("404s PIN management for an unknown user", async () => {
    expect((await setPin(9999, "1234")).statusCode).toBe(404);
    expect((await asAdmin({ method: "GET", url: "/api/users/9999/pin" })).statusCode).toBe(404);
    expect((await asAdmin({ method: "DELETE", url: "/api/users/9999/pin" })).statusCode).toBe(404);
  });

  it("requires an admin session for PIN management", async () => {
    const userId = await createUser("Alice");
    const anon = harness.app;
    expect((await anon.inject({ method: "GET", url: `/api/users/${userId}/pin` })).statusCode).toBe(
      401,
    );
    expect(
      (
        await anon.inject({
          method: "PUT",
          url: `/api/users/${userId}/pin`,
          payload: { pin: "1234" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await anon.inject({ method: "DELETE", url: `/api/users/${userId}/pin` })).statusCode,
    ).toBe(401);
  });

  // --- /app session ---------------------------------------------------------

  it("logs a child in with the right PIN and issues a scoped session", async () => {
    const userId = await createUser("Alice", "America/New_York");
    await setPin(userId, "4242");

    const login = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId, pin: "4242" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({
      authenticated: true,
      user: { id: userId, displayName: "Alice" },
    });
    const pinCookie = cookieFrom(login, PIN_SESSION_COOKIE);

    // Whoami reflects the session.
    const who = await harness.app.inject({
      method: "GET",
      url: "/api/app/session",
      headers: { cookie: pinCookie },
    });
    expect(who.json()).toEqual({ authenticated: true, user: { id: userId, displayName: "Alice" } });

    // The own-data read returns this user's record.
    const me = await harness.app.inject({
      method: "GET",
      url: "/api/app/me",
      headers: { cookie: pinCookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ id: userId, displayName: "Alice", tz: "America/New_York" });
  });

  it("rejects a wrong PIN, an unknown user, and a user with no PIN", async () => {
    const withPin = await createUser("Alice");
    await setPin(withPin, "4242");
    const noPin = await createUser("Bob");

    const wrong = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId: withPin, pin: "0000" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/api/app/session",
          payload: { userId: 9999, pin: "4242" },
        })
      ).statusCode,
    ).toBe(401);

    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: "/api/app/session",
          payload: { userId: noPin, pin: "4242" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("locks a user out after repeated failures", async () => {
    const userId = await createUser("Alice");
    await setPin(userId, "4242");

    // Default limiter: 5 failures, then blocked.
    for (let i = 0; i < 5; i += 1) {
      const res = await harness.app.inject({
        method: "POST",
        url: "/api/app/session",
        payload: { userId, pin: "0000" },
      });
      expect(res.statusCode).toBe(401);
    }
    // Even the correct PIN is now refused with 429 until the window elapses.
    const blocked = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId, pin: "4242" },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("lockout is per (user, ip): an attacker can't lock a child out of their own device", async () => {
    const userId = await createUser("Alice");
    await setPin(userId, "4242");

    // An attacker hammers this user's login from their own IP until it locks.
    for (let i = 0; i < 5; i += 1) {
      await harness.app.inject({
        method: "POST",
        url: "/api/app/session",
        payload: { userId, pin: "0000" },
        remoteAddress: "203.0.113.7",
      });
    }
    const attacker = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId, pin: "4242" },
      remoteAddress: "203.0.113.7",
    });
    expect(attacker.statusCode).toBe(429);

    // The child, on their own device (a different IP), is unaffected and can
    // still sign in with the correct PIN.
    const child = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId, pin: "4242" },
      remoteAddress: "192.168.1.50",
    });
    expect(child.statusCode).toBe(200);
    expect(child.json()).toMatchObject({ authenticated: true, user: { id: userId } });
  });

  it("logs out by clearing the PIN cookie", async () => {
    const userId = await createUser("Alice");
    await setPin(userId, "4242");
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId, pin: "4242" },
    });
    const pinCookie = cookieFrom(login, PIN_SESSION_COOKIE);

    const logout = await harness.app.inject({
      method: "DELETE",
      url: "/api/app/session",
      headers: { cookie: pinCookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ authenticated: false });
    expect(clearsCookie(logout, PIN_SESSION_COOKIE)).toBe(true);
  });

  it("reports unauthenticated whoami without a PIN cookie", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/app/session" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: false });
  });

  // --- deny-by-default scoping ---------------------------------------------

  it("denies /app/me without a PIN session, including with only an admin session", async () => {
    // Anonymous.
    expect((await harness.app.inject({ method: "GET", url: "/api/app/me" })).statusCode).toBe(401);
    // An admin session is NOT a PIN session — the own-data route still rejects it.
    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/app/me",
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("a PIN session does not grant admin access", async () => {
    const userId = await createUser("Alice");
    await setPin(userId, "4242");
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId, pin: "4242" },
    });
    const pinCookie = cookieFrom(login, PIN_SESSION_COOKIE);

    // An admin-guarded route refuses a PIN-only session.
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: pinCookie },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PIN session when auth is unconfigured", () => {
  it("fails closed with 503 on login when PCT_SECRET_KEY is unset", async () => {
    const harness = buildTestApp({
      appOptions: { settings: loadSettings({ PCT_LOG_LEVEL: "silent" }) },
    });
    await harness.app.ready();
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/app/session",
      payload: { userId: 1, pin: "1234" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_not_configured");
    await harness.close();
  });
});
