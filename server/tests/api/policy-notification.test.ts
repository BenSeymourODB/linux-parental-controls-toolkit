/**
 * HTTP tests for the per-user notification-policy routes (#104): drive the
 * `GET`/`PUT`/`DELETE /api/users/:userId/notification-policy` endpoints through
 * `app.inject()` with a genuine admin session. Covers the defaults-when-unset
 * read, the upsert round-trip, the revert-to-defaults delete, the 404 paths,
 * and request validation (sound-profile enum + grace-period bounds).
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "notification-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

describe("notification-policy routes (#104)", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    cookie = sessionCookie(login);
  });

  afterEach(async () => {
    await harness.close();
  });

  function auth(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  async function makeUser(): Promise<number> {
    const res = await auth({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Alice" },
    });
    return res.json().id;
  }

  it("returns the documented defaults when no policy is persisted", async () => {
    const userId = await makeUser();
    const res = await auth({ method: "GET", url: `/api/users/${userId}/notification-policy` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId,
      enabled: true,
      soundProfile: "subtle",
      graceSeconds: 15,
      cadenceOverrides: null,
    });
  });

  it("upserts, persists, and reads back the policy", async () => {
    const userId = await makeUser();
    const put = await auth({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: { enabled: false, soundProfile: "prominent", graceSeconds: 0 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      userId,
      enabled: false,
      soundProfile: "prominent",
      graceSeconds: 0,
      cadenceOverrides: null,
    });

    const get = await auth({ method: "GET", url: `/api/users/${userId}/notification-policy` });
    expect(get.json()).toMatchObject({
      enabled: false,
      soundProfile: "prominent",
      graceSeconds: 0,
    });
  });

  it("merges a partial PUT against the stored row", async () => {
    const userId = await makeUser();
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: { soundProfile: "off", cadenceOverrides: { homework: { suppressSub5: true } } },
    });
    const second = await auth({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: { graceSeconds: 45 },
    });
    expect(second.json()).toEqual({
      userId,
      enabled: true,
      soundProfile: "off",
      graceSeconds: 45,
      cadenceOverrides: { homework: { suppressSub5: true } },
    });
  });

  it("reverts to defaults on DELETE, then 404s when already at defaults", async () => {
    const userId = await makeUser();
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: { enabled: false },
    });

    const del = await auth({ method: "DELETE", url: `/api/users/${userId}/notification-policy` });
    expect(del.statusCode).toBe(204);

    // GET now synthesises the defaults again.
    const get = await auth({ method: "GET", url: `/api/users/${userId}/notification-policy` });
    expect(get.json()).toMatchObject({ enabled: true, soundProfile: "subtle", graceSeconds: 15 });

    // A second delete has nothing to remove → 404 (not a silent 204).
    const again = await auth({ method: "DELETE", url: `/api/users/${userId}/notification-policy` });
    expect(again.statusCode).toBe(404);
  });

  it("404s for an unknown user on every verb", async () => {
    const get = await auth({ method: "GET", url: `/api/users/9999/notification-policy` });
    expect(get.statusCode).toBe(404);
    const put = await auth({
      method: "PUT",
      url: `/api/users/9999/notification-policy`,
      payload: { enabled: true },
    });
    expect(put.statusCode).toBe(404);
    const del = await auth({ method: "DELETE", url: `/api/users/9999/notification-policy` });
    expect(del.statusCode).toBe(404);
  });

  it("rejects an out-of-vocabulary sound profile and an out-of-range grace period", async () => {
    const userId = await makeUser();
    const badProfile = await auth({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: { soundProfile: "blaring" },
    });
    expect(badProfile.statusCode).toBe(400);

    const badGrace = await auth({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: { graceSeconds: 61 },
    });
    expect(badGrace.statusCode).toBe(400);
  });

  it("rejects an empty PUT body", async () => {
    const userId = await makeUser();
    const res = await auth({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("guards every verb behind the admin session", async () => {
    const userId = await makeUser();
    const anonGet = await harness.app.inject({
      method: "GET",
      url: `/api/users/${userId}/notification-policy`,
    });
    expect(anonGet.statusCode).toBe(401);
    const anonPut = await harness.app.inject({
      method: "PUT",
      url: `/api/users/${userId}/notification-policy`,
      payload: { enabled: false },
    });
    expect(anonPut.statusCode).toBe(401);
  });
});
