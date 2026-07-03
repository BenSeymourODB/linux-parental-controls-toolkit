/**
 * Route + wiring tests for the minimal app.
 *
 * Uses `buildTestApp()` (silent logger + bundled in-memory db) and Fastify's
 * `app.inject()` — no sockets, no port binding — per docs/testing.md →
 * "HTTP routes".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/web/app.js";
import { loadSettings } from "../../src/config.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";
import { users } from "../../src/policy/schema.js";

describe("web app routes", () => {
  let harness: TestApp;

  beforeEach(() => {
    // Silent logger keeps route-test output clean; logging behaviour itself
    // is covered in logging.test.ts.
    harness = buildTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("GET / returns the placeholder landing page", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("hello, no policy yet");
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("GET /healthz reports ok", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("unknown routes 404", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/nope" });

    expect(res.statusCode).toBe(404);
  });
});

// trustProxy redefines `request.ip`, which is the key the per-IP
// failed-attempt limiter (auth login, /api/clients/enrol) buckets on (#235).
// Exercised through the admin-login limiter end-to-end via app.inject.
describe("trustProxy and the per-IP failed-attempt limiter (#235)", () => {
  /** Settings with a secret + seeded admin, plus an optional PCT_TRUST_PROXY. */
  function seededSettings(trustProxy?: string) {
    return loadSettings({
      PCT_LOG_LEVEL: "silent",
      PCT_SECRET_KEY: "trust-proxy-test-secret",
      PCT_ADMIN_USERNAME: "ben",
      PCT_ADMIN_PASSWORD: "hunter2",
      ...(trustProxy === undefined ? {} : { PCT_TRUST_PROXY: trustProxy }),
    });
  }

  /** A failed login (wrong password) from a given forwarded client IP. */
  function failedLogin(harness: TestApp, forwardedFor: string) {
    return harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { username: "ben", password: "wrong" },
    });
  }

  // The limiter's default budget is 5 failures per window (auth/rate-limit.ts).
  const MAX_ATTEMPTS = 5;

  it("buckets per forwarded client IP when enabled and trusted", async () => {
    const harness = buildTestApp({ appOptions: { settings: seededSettings("true") } });
    await harness.app.ready();
    try {
      // Exhaust the budget for one client IP behind the proxy.
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        expect((await failedLogin(harness, "203.0.113.5")).statusCode).toBe(401);
      }
      // That IP is now blocked...
      expect((await failedLogin(harness, "203.0.113.5")).statusCode).toBe(429);
      // ...but a different forwarded IP has its own untouched bucket.
      expect((await failedLogin(harness, "198.51.100.9")).statusCode).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("accepts an IP/CIDR allowlist form and trusts only a listed proxy peer", async () => {
    // Allowlist the loopback proxy: the inject peer is 127.0.0.1, so the
    // forwarded header is honoured and `request.ip` is the parsed array shape
    // reaching Fastify 5 at runtime (not just the boolean form). Per-forwarded
    // -IP isolation must hold exactly as in the `true` case.
    const harness = buildTestApp({ appOptions: { settings: seededSettings("127.0.0.1") } });
    await harness.app.ready();
    try {
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        expect((await failedLogin(harness, "203.0.113.5")).statusCode).toBe(401);
      }
      expect((await failedLogin(harness, "203.0.113.5")).statusCode).toBe(429);
      expect((await failedLogin(harness, "198.51.100.9")).statusCode).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("ignores a spoofed X-Forwarded-For when disabled (default)", async () => {
    const harness = buildTestApp({ appOptions: { settings: seededSettings() } });
    await harness.app.ready();
    try {
      // With trustProxy off, the forwarded header is ignored: every request
      // keys on the immediate TCP peer (127.0.0.1), so they share one bucket.
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        expect((await failedLogin(harness, "203.0.113.5")).statusCode).toBe(401);
      }
      // A "different" forwarded IP cannot dodge the block — the header is unused.
      expect((await failedLogin(harness, "198.51.100.9")).statusCode).toBe(429);
    } finally {
      await harness.close();
    }
  });
});

describe("app.db decorator (#49)", () => {
  it("decorates the app with the injected policy db and serves reads/writes", () => {
    const db = testDb();
    const app = buildApp({ settings: loadSettings({ PCT_LOG_LEVEL: "silent" }), db });

    // The decorator is the exact handle that was injected...
    expect(app.db).toBe(db);
    // ...and it is a live, migrated connection routes can query.
    app.db.insert(users).values({ displayName: "Carol" }).run();
    expect(app.db.select().from(users).all()).toHaveLength(1);

    db.$client.close();
  });

  it("leaves an injected db open on app.close() (its owner closes it)", async () => {
    const db = testDb();
    const app = buildApp({ settings: loadSettings({ PCT_LOG_LEVEL: "silent" }), db });

    await app.close();

    // better-sqlite3 marks a closed handle `open: false`; an injected handle
    // must still be open after app.close() so its provider owns the lifecycle.
    expect(db.$client.open).toBe(true);
    db.$client.close();
  });

  it("opens, migrates, and owns a db from settings when none is injected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pct-app-db-"));
    const dbPath = join(dir, "policy.sqlite");
    try {
      // No `db` injected: buildApp calls createDb(settings) and owns the handle.
      const app = buildApp({
        settings: loadSettings({ PCT_LOG_LEVEL: "silent", DATABASE_URL: dbPath }),
      });

      // The owned handle is a live, migrated connection.
      app.db.insert(users).values({ displayName: "Dave" }).run();
      expect(app.db.select().from(users).all()).toHaveLength(1);

      // ...and closing the app closes the handle it owns.
      const client = app.db.$client;
      await app.close();
      expect(client.open).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("app.enforcementPipeline decorator (#327)", () => {
  it("is null by default (no SSH key ⇒ nothing reachable) and starts no timer", () => {
    const db = testDb();
    const app = buildApp({ settings: loadSettings({ PCT_LOG_LEVEL: "silent" }), db });
    // Without a first-run SSH key, the pipeline can reach no client, so buildApp
    // wires null — and constructing the app has started nothing.
    expect(app.enforcementPipeline).toBeNull();
    db.$client.close();
  });

  it("decorates an injected handle and stops it on app.close() (not before)", async () => {
    const db = testDb();
    const stop = vi.fn();
    const start = vi.fn();
    const pipeline = { start, stop, runOnce: vi.fn() };
    const app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "silent" }),
      db,
      enforcementPipeline: pipeline,
    });

    // Decorated as-is; buildApp never starts it (that is main.ts's job).
    expect(app.enforcementPipeline).toBe(pipeline);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    await app.close();
    expect(stop).toHaveBeenCalledTimes(1);
    db.$client.close();
  });
});
