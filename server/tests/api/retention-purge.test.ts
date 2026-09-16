/**
 * HTTP tests for the retention purge routes (#137), driven through the real app
 * via `app.inject()` with a genuine admin session cookie (docs/testing.md →
 * "HTTP routes"). Covers the anonymous-401 guard, the manual run (deletes +
 * records), the side-effect-free preview (counts only), the runs listing
 * (newest-first + limit validation), and that a keep-forever override is
 * honoured.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { activities, auditLog, clients, usageSamples, users } from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function configuredSettings(extra: Record<string, string> = {}) {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "retention-purge-test",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
    ...extra,
  });
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

describe("/api/retention/purge", () => {
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
    // Seed a user/client/activity + one long-expired usage sample and one
    // long-expired audit row; the default window is 365 days.
    const userId = harness.db.insert(users).values({ displayName: "Alice" }).returning().get().id;
    const clientId = harness.db
      .insert(clients)
      .values({ hostname: "alice-pc", sshUser: "pct-agent" })
      .returning()
      .get().id;
    const activityId = harness.db
      .insert(activities)
      .values({ kind: "app", matcher: "firefox" })
      .returning()
      .get().id;
    const old = new Date(Date.now() - 400 * DAY_MS);
    harness.db
      .insert(usageSamples)
      .values({
        userId,
        clientId,
        activityId,
        startedAt: new Date(old.getTime() - 1000),
        endedAt: old,
      })
      .run();
    harness.db
      .insert(auditLog)
      .values({
        at: old,
        targetHost: "alice-pc",
        targetPort: 22,
        targetUser: "pct-agent",
        command: ["timekpra", "--userinfo", "alice"],
        outcome: "ok",
        durationMs: 3,
      })
      .run();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("rejects anonymous access on every purge verb", async () => {
    const run = await harness.app.inject({ method: "POST", url: "/api/retention/purge" });
    const preview = await harness.app.inject({
      method: "POST",
      url: "/api/retention/purge/preview",
    });
    const runs = await harness.app.inject({ method: "GET", url: "/api/retention/purge/runs" });
    expect([run.statusCode, preview.statusCode, runs.statusCode]).toEqual([401, 401, 401]);
  });

  it("preview counts what would be purged without deleting or recording a run", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/retention/purge/preview",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWouldDelete).toBe(2); // the usage sample + the audit row
    const usage = body.items.find((i: { category: string }) => i.category === "usage_samples");
    expect(usage.wouldDelete).toBe(1);
    expect(typeof usage.cutoff).toBe("string"); // ISO cutoff

    // Nothing deleted, nothing recorded.
    expect(harness.db.select().from(usageSamples).all()).toHaveLength(1);
    const runs = await harness.app.inject({
      method: "GET",
      url: "/api/retention/purge/runs",
      headers: { cookie },
    });
    expect(runs.json().runs).toHaveLength(0);
  });

  it("runs the purge, deletes expired rows, and records a manual run", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/retention/purge",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trigger).toBe("manual");
    expect(body.totalDeleted).toBe(2);
    expect(body.id).toBeGreaterThan(0);
    expect(typeof body.at).toBe("string");

    expect(harness.db.select().from(usageSamples).all()).toHaveLength(0);
    expect(harness.db.select().from(auditLog).all()).toHaveLength(0);

    // The run shows up in the listing as the latest.
    const runs = await harness.app.inject({
      method: "GET",
      url: "/api/retention/purge/runs",
      headers: { cookie },
    });
    expect(runs.json().runs[0]).toMatchObject({ id: body.id, trigger: "manual", totalDeleted: 2 });
  });

  it("honours a keep-forever override set via PUT before the purge", async () => {
    await harness.app.inject({
      method: "PUT",
      url: "/api/retention/usage_samples",
      headers: { cookie },
      payload: { keepForever: true },
    });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/retention/purge",
      headers: { cookie },
    });
    const body = res.json();
    // usage_samples kept forever; only the audit row is purged.
    expect(body.totalDeleted).toBe(1);
    expect(harness.db.select().from(usageSamples).all()).toHaveLength(1);
  });

  it("lists runs newest-first and validates the limit query", async () => {
    // Two manual runs.
    await harness.app.inject({ method: "POST", url: "/api/retention/purge", headers: { cookie } });
    await harness.app.inject({ method: "POST", url: "/api/retention/purge", headers: { cookie } });

    const limited = await harness.app.inject({
      method: "GET",
      url: "/api/retention/purge/runs?limit=1",
      headers: { cookie },
    });
    expect(limited.json().runs).toHaveLength(1);

    const bad = await harness.app.inject({
      method: "GET",
      url: "/api/retention/purge/runs?limit=0",
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});
