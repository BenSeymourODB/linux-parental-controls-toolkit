/**
 * HTTP tests for the client health/status routes (#81), driven through the real
 * app via `app.inject()` with a genuine admin session cookie (per
 * docs/testing.md → "HTTP routes"). The app wires these routes with **no live
 * prober** (pre-#39), so they exercise the degraded path: real enrolment +
 * queue state, with reachability/components reported `unknown`.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../../src/auth/session.js";
import { loadSettings } from "../../../src/config.js";
import * as repo from "../../../src/policy/repository.js";
import { enqueue } from "../../../src/transport/queue/index.js";
import { buildTestApp, type TestApp } from "../../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "health-test-secret",
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

describe("client health routes", () => {
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

  it("rejects anonymous access with a 401 envelope", async () => {
    for (const url of ["/api/clients/health", "/api/clients/1/health"]) {
      const res = await harness.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  it("lists per-client health (degraded to unknown without a live prober)", async () => {
    const client = repo.createClient(harness.db, {
      hostname: "alice-pc.local",
      sshUser: "pct-agent",
    });

    const res = await auth({ method: "GET", url: "/api/clients/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].clientId).toBe(client.id);
    expect(body[0].hostname).toBe("alice-pc.local");
    expect(body[0].reachability).toBe("unknown");
    expect(body[0].probedAt).toBeNull();
    expect(body[0].components).toHaveLength(5);
    expect(body[0].queue).toEqual({ pending: 0, failed: 0, actions: [] });
  });

  it("returns one client's health by id and surfaces its queued changes", async () => {
    const client = repo.createClient(harness.db, {
      hostname: "alice-pc.local",
      sshUser: "pct-agent",
    });
    enqueue(harness.db, {
      clientId: client.id,
      coalesceKey: "policy.push:user:1",
      kind: "policy.push",
      payload: { a: 1 },
    });

    const res = await auth({ method: "GET", url: `/api/clients/${client.id}/health` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.clientId).toBe(client.id);
    expect(body.queue.pending).toBe(1);
    expect(body.queue.actions[0].coalesceKey).toBe("policy.push:user:1");
  });

  it("404s for a client that does not exist", async () => {
    const res = await auth({ method: "GET", url: "/api/clients/999/health" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("400s on a non-numeric client id", async () => {
    const res = await auth({ method: "GET", url: "/api/clients/abc/health" });
    expect(res.statusCode).toBe(400);
  });
});
