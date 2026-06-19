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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
