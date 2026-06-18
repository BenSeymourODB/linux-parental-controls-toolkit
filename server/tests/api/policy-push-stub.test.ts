/**
 * End-to-end tests for the Phase-2 stub transport seam (#54): drive real #51
 * policy mutations through `app.inject()` (with a genuine admin session) and
 * assert the structured `transport/stub` "would push" line — one per affected
 * client — that the stub logs in lieu of an SSH/Ansible dispatch.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { PUSH_STUB_COMPONENT, PUSH_STUB_MESSAGE } from "../../src/transport/stub.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

/** Settings with a secret, a seeded admin, and `info` logging (so the stub's
 * `info` lines reach the capture stream). */
function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "info",
    PCT_SECRET_KEY: "push-stub-test-secret",
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

describe("stub transport push on policy change (#54)", () => {
  let harness: TestApp;
  let cookie: string;
  let lines: Record<string, unknown>[];

  beforeEach(async () => {
    lines = [];
    harness = buildTestApp({
      appOptions: {
        settings: configuredSettings(),
        loggerStream: {
          write(msg: string) {
            lines.push(JSON.parse(msg) as Record<string, unknown>);
          },
        },
      },
    });
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

  function auth(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  /** Stub "would push" lines emitted so far, optionally filtered by reason. */
  function pushLines(reason?: string): Record<string, unknown>[] {
    return lines.filter(
      (l) =>
        l.component === PUSH_STUB_COMPONENT &&
        l.msg === PUSH_STUB_MESSAGE &&
        (reason === undefined || l.reason === reason),
    );
  }

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

  it("logs a client.created push targeting the new client with a null user", async () => {
    const created = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "mint-01", sshUser: "pct-agent" },
      })
    ).json();

    const pushed = pushLines("client.created");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      clientId: created.id,
      userId: null,
      reason: "client.created",
      detail: { hostname: "mint-01", sshUser: "pct-agent" },
    });
  });

  it("emits no push line when a user is created with no client links", async () => {
    await auth({ method: "POST", url: "/api/users", payload: { displayName: "Alice" } });
    expect(pushLines("user.created")).toHaveLength(0);
  });

  it("logs a link.upserted push for the affected user/client pair", async () => {
    const { userId, clientId } = await makeUserAndClient();

    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });

    const pushed = pushLines("link.upserted");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      clientId,
      userId,
      reason: "link.upserted",
      detail: { linuxUsername: "alice", linuxUid: 1001 },
    });
  });

  it("logs a user.updated push for every client the user is linked to", async () => {
    const { userId, clientId } = await makeUserAndClient();
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });

    await auth({
      method: "PATCH",
      url: `/api/users/${userId}`,
      payload: { displayName: "Alice Renamed" },
    });

    const pushed = pushLines("user.updated");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      clientId,
      userId,
      reason: "user.updated",
      detail: { displayName: "Alice Renamed" },
    });
  });

  it("fans a user.updated push out to every client the user is linked to", async () => {
    const { userId, clientId } = await makeUserAndClient();
    const secondClientId = (
      await auth({
        method: "POST",
        url: "/api/clients",
        payload: { hostname: "mint-02", sshUser: "pct-agent" },
      })
    ).json().id;
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${secondClientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1002 },
    });

    await auth({
      method: "PATCH",
      url: `/api/users/${userId}`,
      payload: { displayName: "Alice Renamed" },
    });

    const pushed = pushLines("user.updated");
    expect(pushed).toHaveLength(2);
    expect(new Set(pushed.map((l) => l.clientId))).toEqual(new Set([clientId, secondClientId]));
    for (const line of pushed) {
      expect(line).toMatchObject({
        userId,
        reason: "user.updated",
        detail: { displayName: "Alice Renamed" },
      });
    }
  });

  it("logs a user.deleted push for each linked client (resolved before cascade)", async () => {
    const { userId, clientId } = await makeUserAndClient();
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });

    await auth({ method: "DELETE", url: `/api/users/${userId}` });

    const pushed = pushLines("user.deleted");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ clientId, userId, reason: "user.deleted" });
  });

  it("logs a link.deleted push when a link is removed", async () => {
    const { userId, clientId } = await makeUserAndClient();
    await auth({
      method: "PUT",
      url: `/api/users/${userId}/clients/${clientId}`,
      payload: { linuxUsername: "alice", linuxUid: 1001 },
    });

    await auth({ method: "DELETE", url: `/api/users/${userId}/clients/${clientId}` });

    const pushed = pushLines("link.deleted");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ clientId, userId, reason: "link.deleted" });
  });

  it("does not emit a stub line for reads or rejected writes", async () => {
    const before = pushLines().length;

    await auth({ method: "GET", url: "/api/users" });
    // Invalid timezone → 400, short-circuited before the handler.
    const bad = await auth({
      method: "POST",
      url: "/api/users",
      payload: { displayName: "Alice", tz: "Mars/Phobos" },
    });
    expect(bad.statusCode).toBe(400);
    // Anonymous write → 401, guarded before the handler.
    const anon = await harness.app.inject({
      method: "POST",
      url: "/api/clients",
      payload: { hostname: "nope", sshUser: "pct-agent" },
    });
    expect(anon.statusCode).toBe(401);

    expect(pushLines().length).toBe(before);
  });
});
