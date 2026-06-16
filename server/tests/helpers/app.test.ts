/**
 * Smoke test for the {@link buildTestApp} helper: it returns a working
 * Fastify instance (exercised via `app.inject()`), a usable migrated DB, and
 * a `close()` that tears both down.
 */
import { describe, expect, it } from "vitest";

import { buildTestApp } from "./app.js";

describe("buildTestApp helper", () => {
  it("builds an injectable app paired with a migrated db", async () => {
    const { app, db, close } = buildTestApp();

    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    // The bundled db is migrated and queryable.
    const row = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      )
      .get();
    expect(row).not.toBeUndefined();

    await close();
  });

  it("accepts a caller-supplied db", async () => {
    const db = (await import("./db.js")).testDb();
    const { db: bundled, close } = buildTestApp({ db });

    expect(bundled).toBe(db);

    await close();
  });
});
