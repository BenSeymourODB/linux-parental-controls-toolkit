/**
 * Smoke test for the {@link buildTestApp} helper: it returns a working
 * Fastify instance (exercised via `app.inject()`), a usable migrated DB, and
 * a `close()` that tears both down.
 */
import { describe, expect, it } from "vitest";

import { buildTestApp } from "./app.js";
import { testDb } from "./db.js";

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

  it("accepts a caller-supplied db and wires it through to app.db", async () => {
    const db = testDb();
    const { app, db: bundled, close } = buildTestApp({ db });

    // The returned db, the injected db, and app.db are all the same handle.
    expect(bundled).toBe(db);
    expect(app.db).toBe(db);

    await close();
  });
});
