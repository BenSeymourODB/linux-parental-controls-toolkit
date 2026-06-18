/**
 * HTTP tests for the account/device-core CRUD routes (#51), driven through the
 * real app via `app.inject()` with a genuine admin session cookie — per
 * docs/testing.md → "HTTP routes". Covers happy paths, validation failures,
 * the anonymous-401 guard, 404s, and 409 conflicts for each entity.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

/** Settings with a secret and a seeded admin (`ben` / `hunter2`). */
function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "policy-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

/** Pull the `pct_session=<signed>` wire cookie out of a login response. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

describe("policy CRUD routes", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready(); // triggers first-admin bootstrap
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

  /** Inject with the admin session cookie attached. */
  function auth(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  // --- auth guard ----------------------------------------------------------

  it("rejects anonymous access to every collection with a 401 envelope", async () => {
    for (const url of ["/api/users", "/api/clients"]) {
      const res = await harness.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  it("rejects an anonymous write with a 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Mallory" },
    });
    expect(res.statusCode).toBe(401);
  });

  // --- users ---------------------------------------------------------------

  it("creates a user (201) and reads it back", async () => {
    const created = await auth({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Alice", tz: "Europe/London" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ displayName: "Alice", tz: "Europe/London" });
    expect(typeof body.id).toBe("number");
    expect(typeof body.createdAt).toBe("string");

    const list = await auth({ method: "GET", url: "/api/users" });
    expect(list.json()).toEqual([body]);

    const one = await auth({ method: "GET", url: `/api/users/${body.id}` });
    expect(one.json()).toEqual(body);
  });

  it("rejects an invalid timezone with a 400 validation envelope", async () => {
    const res = await auth({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Alice", tz: "Mars/Phobos" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects an empty user body with a 400", async () => {
    const res = await auth({ method: "POST", url: "/api/users", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("patches a user, clearing tz with an explicit null", async () => {
    const created = (
      await auth({
        method: "POST",
        url: "/api/users",
        payload: { displayName: "Alice", tz: "Europe/London" },
      })
    ).json();

    const patched = await auth({
      method: "PATCH",
      url: `/api/users/${created.id}`,
      payload: { tz: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ displayName: "Alice", tz: null });
  });

  it("rejects a no-op (empty) PATCH with a 400", async () => {
    const created = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } })
    ).json();
    const res = await auth({ method: "PATCH", url: `/api/users/${created.id}`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("deletes a user (204) and 404s afterwards", async () => {
    const created = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } })
    ).json();
    const del = await auth({ method: "DELETE", url: `/api/users/${created.id}` });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");

    const missing = await auth({ method: "GET", url: `/api/users/${created.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });

  it("404s on patch/delete of a missing user", async () => {
    const patch = await auth({
      method: "PATCH",
      url: "/api/users/999",
      payload: { displayName: "x" },
    });
    expect(patch.statusCode).toBe(404);
    const del = await auth({ method: "DELETE", url: "/api/users/999" });
    expect(del.statusCode).toBe(404);
  });

  it("rejects a non-numeric id with a 400", async () => {
    const res = await auth({ method: "GET", url: "/api/users/abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  // --- clients -------------------------------------------------------------

  it("creates a client (201), updates it, and lists it", async () => {
    const created = await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "mint-01", sshUser: "pct-agent" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ hostname: "mint-01", sshUser: "pct-agent", lastSeen: null });

    const patched = await auth({
      method: "PATCH",
      url: `/api/clients/${body.id}`,
      payload: { hostname: "mint-renamed" },
    });
    expect(patched.json().hostname).toBe("mint-renamed");

    const one = await auth({ method: "GET", url: `/api/clients/${body.id}` });
    expect(one.json()).toMatchObject({ id: body.id, hostname: "mint-renamed" });

    const list = await auth({ method: "GET", url: "/api/clients" });
    expect(list.json()).toHaveLength(1);
  });

  it("409s on a duplicate hostname", async () => {
    await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "dup", sshUser: "pct-agent" },
    });
    const conflict = await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "dup", sshUser: "pct-agent" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("conflict");
  });

  it("409s when a client PATCH collides with another hostname", async () => {
    await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "taken", sshUser: "pct-agent" },
    });
    const second = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "free", sshUser: "pct-agent" },
      })
    ).json();
    const res = await auth({
      method: "PATCH",
      url: `/api/clients/${second.id}`,
      payload: { hostname: "taken" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects an empty hostname with a 400 and 404s a missing client", async () => {
    const bad = await auth({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "", sshUser: "pct-agent" },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await auth({ method: "GET", url: "/api/clients/999" });
    expect(missing.statusCode).toBe(404);
  });

  it("404s on patch/delete of a missing client", async () => {
    const patch = await auth({
      method: "PATCH",
      url: "/api/clients/999",
      payload: { sshUser: "pct-agent" },
    });
    expect(patch.statusCode).toBe(404);
    expect(patch.json().error.code).toBe("not_found");

    const del = await auth({ method: "DELETE", url: "/api/clients/999" });
    expect(del.statusCode).toBe(404);
  });

  it("deletes a client (204)", async () => {
    const created = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "to-remove", sshUser: "pct-agent" },
      })
    ).json();
    const del = await auth({ method: "DELETE", url: `/api/clients/${created.id}` });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
  });

  // --- links ---------------------------------------------------------------

  async function makeUserAndClient(): Promise<{ userId: number; clientId: number }> {
    const userId = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } })
    ).json().id;
    const clientId = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "mint-01", sshUser: "pct-agent" },
      })
    ).json().id;
    return { userId, clientId };
  }

  it("upserts a link and lists it under the user", async () => {
    const { userId, clientId } = await makeUserAndClient();
    const put = await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ userId, clientId, linuxUsername: "alice", linuxUid: 1001 });

    const list = await auth({ method: "GET", url: `/api/users/${userId}/clients` });
    expect(list.json()).toHaveLength(1);

    // Idempotent replace.
    const again = await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice2", linuxUid: 1002 },
    });
    expect(again.json().linuxUid).toBe(1002);
    expect(
      (await auth({ method: "GET", url: `/api/users/${userId}/clients` })).json(),
    ).toHaveLength(1);
  });

  it("404s a link PUT when the user or client is missing", async () => {
    const { userId, clientId } = await makeUserAndClient();
    const noUser = await auth({
      method: "PUT",
      url: `/api/users/999/clients/${clientId}`,
      payload: { linuxUsername: "x", linuxUid: 1001 },
    });
    expect(noUser.statusCode).toBe(404);
    const noClient = await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/999`,
      payload: { linuxUsername: "x", linuxUid: 1001 },
    });
    expect(noClient.statusCode).toBe(404);
  });

  it("404s listing links for a missing user", async () => {
    const res = await auth({ method: "GET", url: "/api/users/999/clients" });
    expect(res.statusCode).toBe(404);
  });

  it("409s when a UID is already mapped to another user on the same client", async () => {
    const { userId, clientId } = await makeUserAndClient();
    const otherUser = (
      await auth({ method: "POST", url: "/api/users", payload: { displayName: "Bob" } })
    ).json().id;
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });
    const conflict = await auth({
      method: "PUT",
      url: `/api/users/${otherUser}/clients/${clientId}`,
      payload: { linuxUsername: "bob", linuxUid: 1001 },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("deletes a link (204) and 404s afterwards", async () => {
    const { userId, clientId } = await makeUserAndClient();
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });
    const del = await auth({ method: "DELETE", url: `/api/users/${userId}/clients/${clientId}` });
    expect(del.statusCode).toBe(204);
    const again = await auth({ method: "DELETE", url: `/api/users/${userId}/clients/${clientId}` });
    expect(again.statusCode).toBe(404);
  });
});
