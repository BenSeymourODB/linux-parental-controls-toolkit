/**
 * HTTP tests for the manual "push saved policy now" route (#304):
 * `POST /api/users/:userId/policy-push`.
 *
 * Driven through the real app via `app.inject()` with a genuine admin cookie.
 * A fake {@link PolicyPushTransport} carrying a `pushPolicyNow` is injected so
 * the 200 path runs without SSH; a separate app built without one exercises the
 * 503 fallback.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { createClient, createUser, upsertLink } from "../../src/policy/repository.js";
import {
  PushNowTargetError,
  type PolicyPushTransport,
  type PushUserPolicyRequest,
  type PushUserPolicyResult,
} from "../../src/transport/policy-push/index.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "policy-push-secret",
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

/** A recording fake transport: the dispatcher is inert, the pusher is provided. */
function fakeTransport(push: (r: PushUserPolicyRequest) => Promise<PushUserPolicyResult>): {
  transport: PolicyPushTransport;
  calls: PushUserPolicyRequest[];
} {
  const calls: PushUserPolicyRequest[] = [];
  return {
    calls,
    transport: {
      dispatcher: { push: () => undefined },
      pushPolicyNow: (r) => {
        calls.push(r);
        return push(r);
      },
      dispose: () => undefined,
    },
  };
}

describe("POST /api/users/:userId/policy-push", () => {
  let harness: TestApp;
  let cookie: string;
  let calls: PushUserPolicyRequest[];

  async function setup(
    push: (r: PushUserPolicyRequest) => Promise<PushUserPolicyResult>,
  ): Promise<void> {
    const fake = fakeTransport(push);
    calls = fake.calls;
    harness = buildTestApp({
      appOptions: { settings: configuredSettings(), policyPush: fake.transport },
    });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    cookie = sessionCookie(login);
  }

  afterEach(async () => {
    await harness.close();
  });

  function auth(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  function seedLinkedUser(): number {
    const userId = createUser(harness.db, { displayName: "Alice", tz: "UTC" }).id;
    const clientId = createClient(harness.db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    upsertLink(harness.db, userId, clientId, { osUsername: "alice", osUserRef: "1001" });
    return userId;
  }

  it("rejects anonymous access with a 401", async () => {
    await setup(async () => ({ results: [] }));
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/users/1/policy-push",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("pushes to all linked clients and returns the per-client results", async () => {
    await setup(async () => ({
      results: [
        { clientId: 7, hostname: "mint-01", osUsername: "alice", status: "pushed" },
        {
          clientId: 8,
          hostname: "mint-02",
          osUsername: "alice",
          status: "queued",
          error: "offline",
        },
      ],
    }));
    const userId = seedLinkedUser();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-push`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId,
      results: [
        { clientId: 7, hostname: "mint-01", osUsername: "alice", status: "pushed" },
        {
          clientId: 8,
          hostname: "mint-02",
          osUsername: "alice",
          status: "queued",
          error: "offline",
        },
      ],
    });
    expect(calls).toEqual([{ userId }]);
  });

  it("forwards a requested clientId to the pusher", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();

    await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-push`,
      payload: { clientId: 42 },
    });

    expect(calls[0]).toEqual({ userId, clientId: 42 });
  });

  it("404s for a non-existent user (before touching the transport)", async () => {
    await setup(async () => ({ results: [] }));
    const res = await auth({
      method: "POST",
      url: "/api/users/9999/policy-push",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(calls).toHaveLength(0);
  });

  it("409 no_linked_clients when the user has no links", async () => {
    await setup(async () => {
      throw new PushNowTargetError("User has no links");
    });
    const userId = createUser(harness.db, { displayName: "Bob", tz: "UTC" }).id;

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-push`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("no_linked_clients");
  });

  it("404 when a given clientId isn't linked to the user", async () => {
    await setup(async () => {
      throw new PushNowTargetError("not linked to client 42");
    });
    const userId = seedLinkedUser();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-push`,
      payload: { clientId: 42 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("surfaces a per-client failed outcome with a 200", async () => {
    await setup(async () => ({
      results: [
        { clientId: 7, hostname: "mint-01", osUsername: "alice", status: "failed", error: "boom" },
      ],
    }));
    const userId = seedLinkedUser();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-push`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toEqual({
      clientId: 7,
      hostname: "mint-01",
      osUsername: "alice",
      status: "failed",
      error: "boom",
    });
  });

  it("rejects a non-positive clientId (400)", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/policy-push`,
      payload: { clientId: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/users/:userId/policy-push without a live transport", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    // No `policyPush` injected and no SSH key → the fallback transport has no
    // pusher, so the route reports the transport as unavailable.
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

  it("503 transport_unavailable when no pusher is wired", async () => {
    const userId = createUser(harness.db, { displayName: "Alice", tz: "UTC" }).id;
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/users/${userId}/policy-push`,
      payload: {},
      headers: { cookie },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("transport_unavailable");
  });
});
