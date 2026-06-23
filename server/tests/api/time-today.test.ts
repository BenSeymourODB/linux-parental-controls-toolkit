/**
 * HTTP tests for the "Add time today" route (#257):
 * `POST /api/users/:userId/time-today`.
 *
 * Driven through the real app via `app.inject()` with a genuine admin cookie.
 * A fake {@link PolicyPushTransport} is injected so the route's 200 path runs
 * without SSH; a separate app built without one exercises the 503 fallback.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { createClient, createUser, upsertLink } from "../../src/policy/repository.js";
import type { PolicyPushTransport } from "../../src/transport/policy-push/index.js";
import {
  TimeTodayTargetError,
  type TimeTodayAdjustment,
  type TimeTodayResult,
} from "../../src/transport/time-today/index.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "time-today-secret",
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

/** A recording fake transport: the dispatcher is inert, the adjuster is provided. */
function fakeTransport(adjust: (a: TimeTodayAdjustment) => Promise<TimeTodayResult>): {
  transport: PolicyPushTransport;
  calls: TimeTodayAdjustment[];
} {
  const calls: TimeTodayAdjustment[] = [];
  return {
    calls,
    transport: {
      dispatcher: { push: () => undefined },
      adjustTimeToday: (a) => {
        calls.push(a);
        return adjust(a);
      },
      dispose: () => undefined,
    },
  };
}

describe("POST /api/users/:userId/time-today", () => {
  let harness: TestApp;
  let cookie: string;
  let calls: TimeTodayAdjustment[];

  async function setup(
    adjust: (a: TimeTodayAdjustment) => Promise<TimeTodayResult>,
  ): Promise<void> {
    const fake = fakeTransport(adjust);
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
      url: "/api/users/1/time-today",
      payload: { deltaSeconds: 1800 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("applies a positive delta as a `+` op and returns the per-client results", async () => {
    await setup(async () => ({
      results: [{ clientId: 7, osUsername: "alice", status: "applied" }],
    }));
    const userId = seedLinkedUser();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 1800 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId,
      operation: "+",
      seconds: 1800,
      results: [{ clientId: 7, osUsername: "alice", status: "applied" }],
    });
    expect(calls).toEqual([{ userId, operation: "+", seconds: 1800 }]);
  });

  it("maps a negative delta to a `-` op with the magnitude", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();

    await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: -600 },
    });

    expect(calls[0]).toMatchObject({ operation: "-", seconds: 600 });
  });

  it("maps setSeconds to a `=` op and forwards clientId", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();

    await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { setSeconds: 0, clientId: 42 },
    });

    expect(calls[0]).toMatchObject({ operation: "=", seconds: 0, clientId: 42 });
  });

  it("404s for a non-existent user (before touching the transport)", async () => {
    await setup(async () => ({ results: [] }));
    const res = await auth({
      method: "POST",
      url: "/api/users/9999/time-today",
      payload: { deltaSeconds: 1800 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(calls).toHaveLength(0);
  });

  it("409 no_linked_clients when the user has no links", async () => {
    await setup(async () => {
      throw new TimeTodayTargetError("User has no links");
    });
    const userId = createUser(harness.db, { displayName: "Bob", tz: "UTC" }).id;

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 1800 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("no_linked_clients");
  });

  it("404 when a given clientId isn't linked to the user", async () => {
    await setup(async () => {
      throw new TimeTodayTargetError("not linked to client 42");
    });
    const userId = seedLinkedUser();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 1800, clientId: 42 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("surfaces a per-client unreachable outcome with a 200 (not queued)", async () => {
    await setup(async () => ({
      results: [{ clientId: 7, osUsername: "alice", status: "unreachable", error: "offline" }],
    }));
    const userId = seedLinkedUser();

    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 900 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toEqual({
      clientId: 7,
      osUsername: "alice",
      status: "unreachable",
      error: "offline",
    });
  });

  it("rejects a body with neither delta nor set (400)", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a body with both delta and set (400)", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 1800, setSeconds: 3600 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a zero delta (400)", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a delta beyond one day (400)", async () => {
    await setup(async () => ({ results: [] }));
    const userId = seedLinkedUser();
    const res = await auth({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 86_401 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/users/:userId/time-today without a live transport", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    // No `policyPush` injected and no SSH key → the fallback transport has no
    // adjuster, so the route reports the transport as unavailable.
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

  it("503 transport_unavailable when no adjuster is wired", async () => {
    const userId = createUser(harness.db, { displayName: "Alice", tz: "UTC" }).id;
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/users/${userId}/time-today`,
      payload: { deltaSeconds: 1800 },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("transport_unavailable");
  });
});
