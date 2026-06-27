/**
 * HTTP tests for the retention config routes (#136), driven through the real
 * app via `app.inject()` with a genuine admin session cookie — per
 * docs/testing.md → "HTTP routes". Covers the anonymous-401 guard, the
 * default-inheriting read, override set/clear round-trips (custom + keep
 * forever), idempotent delete, validation 400s, and a non-default global
 * window from settings.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings(extra: Record<string, string> = {}) {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "retention-test-secret",
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

async function newHarness(extra: Record<string, string> = {}): Promise<{
  harness: TestApp;
  cookie: string;
}> {
  const harness = buildTestApp({ appOptions: { settings: configuredSettings(extra) } });
  await harness.app.ready();
  const login = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "ben", password: "hunter2" },
  });
  return { harness, cookie: sessionCookie(login) };
}

describe("/api/retention", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ({ harness, cookie } = await newHarness());
  });

  afterEach(async () => {
    await harness.close();
  });

  it("rejects anonymous access on every verb", async () => {
    const get = await harness.app.inject({ method: "GET", url: "/api/retention" });
    expect(get.statusCode).toBe(401);
    const put = await harness.app.inject({
      method: "PUT",
      url: "/api/retention/usage_samples",
      payload: { keepForever: false, days: 30 },
    });
    expect(put.statusCode).toBe(401);
    const del = await harness.app.inject({ method: "DELETE", url: "/api/retention/usage_samples" });
    expect(del.statusCode).toBe(401);
  });

  it("returns every category inheriting the default when no overrides are set", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/retention",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultDays).toBe(365);
    expect(body.categories).toHaveLength(4);
    for (const entry of body.categories) {
      expect(entry.source).toBe("default");
      expect(entry.keepForever).toBe(false);
      expect(entry.days).toBe(365);
      expect(entry.updatedAt).toBeNull();
    }
    expect(body.categories.map((e: { category: string }) => e.category)).toEqual([
      "usage_samples",
      "grant_ledger",
      "audit_log",
      "date_overrides",
    ]);
  });

  it("sets a custom-window override and reflects it in the read", async () => {
    const put = await harness.app.inject({
      method: "PUT",
      url: "/api/retention/usage_samples",
      headers: { cookie },
      payload: { keepForever: false, days: 30 },
    });
    expect(put.statusCode).toBe(200);
    const entry = put.json();
    expect(entry).toMatchObject({
      category: "usage_samples",
      source: "override",
      keepForever: false,
      days: 30,
    });
    expect(typeof entry.updatedAt).toBe("string");

    const get = await harness.app.inject({
      method: "GET",
      url: "/api/retention",
      headers: { cookie },
    });
    const usage = get
      .json()
      .categories.find((e: { category: string }) => e.category === "usage_samples");
    expect(usage).toMatchObject({ source: "override", days: 30 });
  });

  it("sets a keep-forever override with a null day count", async () => {
    const put = await harness.app.inject({
      method: "PUT",
      url: "/api/retention/audit_log",
      headers: { cookie },
      payload: { keepForever: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ source: "override", keepForever: true, days: null });
  });

  it("upserts in place when the same category is set twice", async () => {
    await harness.app.inject({
      method: "PUT",
      url: "/api/retention/grant_ledger",
      headers: { cookie },
      payload: { keepForever: false, days: 90 },
    });
    await harness.app.inject({
      method: "PUT",
      url: "/api/retention/grant_ledger",
      headers: { cookie },
      payload: { keepForever: true },
    });
    const get = await harness.app.inject({
      method: "GET",
      url: "/api/retention",
      headers: { cookie },
    });
    const overrides = get
      .json()
      .categories.filter((e: { source: string }) => e.source === "override");
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ category: "grant_ledger", keepForever: true });
  });

  it("clears an override (idempotently) reverting to the default", async () => {
    await harness.app.inject({
      method: "PUT",
      url: "/api/retention/date_overrides",
      headers: { cookie },
      payload: { keepForever: false, days: 14 },
    });
    const del = await harness.app.inject({
      method: "DELETE",
      url: "/api/retention/date_overrides",
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ source: "default", days: 365, updatedAt: null });

    // A second delete is a no-op that still reports the default entry.
    const again = await harness.app.inject({
      method: "DELETE",
      url: "/api/retention/date_overrides",
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ source: "default" });
  });

  it("rejects an unknown category", async () => {
    const res = await harness.app.inject({
      method: "PUT",
      url: "/api/retention/schedule_history",
      headers: { cookie },
      payload: { keepForever: false, days: 30 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid day count", async () => {
    for (const days of [0, -5, 12.5, 99_999_999]) {
      const res = await harness.app.inject({
        method: "PUT",
        url: "/api/retention/usage_samples",
        headers: { cookie },
        payload: { keepForever: false, days },
      });
      expect(res.statusCode, `days=${days}`).toBe(400);
    }
  });

  it("rejects a custom window with no day count", async () => {
    const res = await harness.app.inject({
      method: "PUT",
      url: "/api/retention/usage_samples",
      headers: { cookie },
      payload: { keepForever: false },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("/api/retention with a non-default global window", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ({ harness, cookie } = await newHarness({ PCT_RETENTION_DEFAULT_DAYS: "30" }));
  });

  afterEach(async () => {
    await harness.close();
  });

  it("surfaces the configured default for inheriting categories", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/retention",
      headers: { cookie },
    });
    const body = res.json();
    expect(body.defaultDays).toBe(30);
    for (const entry of body.categories) {
      expect(entry.days).toBe(30);
    }
  });
});
