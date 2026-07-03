/**
 * HTTP tests for the fleet-wide queue-summary route `GET /api/system/queue-summary`
 * (#322), driven through the real app via `app.inject()` with a genuine admin
 * session cookie — per docs/testing.md -> "HTTP routes". Covers the anonymous-401
 * guard, the empty (calm) summary, and a seeded pending + dead-lettered mix with
 * the ISO oldest-pending anchor. Rows are seeded straight into the bundled
 * in-memory DB the route reads (`app.db`), so no live transport is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { createClient } from "../../src/policy/repository.js";
import * as queue from "../../src/transport/queue/repository.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function settings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "queue-summary-test-secret",
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

let harness: TestApp;

async function login(): Promise<string> {
  const res = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "ben", password: "hunter2" },
  });
  return sessionCookie(res);
}

beforeEach(async () => {
  harness = buildTestApp({ appOptions: { settings: settings() } });
  await harness.app.ready();
});

afterEach(async () => {
  await harness.close();
});

describe("GET /api/system/queue-summary", () => {
  it("rejects an anonymous request with 401", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/system/queue-summary" });
    expect(res.statusCode).toBe(401);
  });

  it("returns a calm empty summary when the queue is empty", async () => {
    const cookie = await login();
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/system/queue-summary",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pending: 0, failed: 0, oldestPendingAt: null });
  });

  it("aggregates pending + failed counts and serialises the oldest-pending anchor", async () => {
    const clientId = createClient(harness.db, { hostname: "mint-01", sshUser: "pct-agent" }).id;
    const first = queue.enqueue(harness.db, {
      clientId,
      coalesceKey: "user:1",
      kind: "policy.push",
      payload: {},
    });
    queue.enqueue(harness.db, {
      clientId,
      coalesceKey: "user:2",
      kind: "policy.push",
      payload: {},
    });
    const doomed = queue.enqueue(harness.db, {
      clientId,
      coalesceKey: "user:3",
      kind: "policy.push",
      payload: {},
    });
    queue.markFailed(harness.db, doomed.id, "exit code 1");

    const cookie = await login();
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/system/queue-summary",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pending).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.oldestPendingAt).toBe(first.enqueuedAt.toISOString());
  });
});
