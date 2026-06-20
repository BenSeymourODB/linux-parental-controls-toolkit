/**
 * Static-mount tests for the SvelteKit build surfaces (#40).
 *
 * Builds a throwaway fixture directory shaped like `adapter-static` output
 * (`admin.html`, `app.html`, a hashed `_app/…` chunk, a static file) and
 * points `PCT_FRONTEND_ROOT` at it, then exercises the mount via
 * `app.inject()` — no sockets, per docs/testing.md → "HTTP routes".
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/web/app.js";
import { loadSettings } from "../../src/config.js";
import { testDb, type TestDb } from "../helpers/db.js";

const ADMIN_HTML = "<!doctype html><title>admin</title><div id=admin-marker>";
const APP_HTML = "<!doctype html><title>app</title><div id=app-marker>";
const CHUNK_JS = "export const x = 1; // hashed _app chunk";
const FAVICON = "fake-png-bytes";

/** Write a fixture directory shaped like the prerendered build output. */
function makeFixtureBuild(): string {
  const root = mkdtempSync(join(tmpdir(), "pct-frontend-"));
  writeFileSync(join(root, "admin.html"), ADMIN_HTML);
  writeFileSync(join(root, "app.html"), APP_HTML);
  writeFileSync(join(root, "favicon.png"), FAVICON);
  mkdirSync(join(root, "_app", "immutable"), { recursive: true });
  writeFileSync(join(root, "_app", "immutable", "chunk.js"), CHUNK_JS);
  return root;
}

describe("frontend static mount (build present)", () => {
  let app: FastifyInstance;
  let db: TestDb;
  let root: string;

  beforeEach(() => {
    root = makeFixtureBuild();
    db = testDb();
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "silent", PCT_FRONTEND_ROOT: root }),
      db,
    });
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves admin.html as HTML at /admin", async () => {
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("admin-marker");
  });

  it("serves app.html as HTML at /app", async () => {
    const res = await app.inject({ method: "GET", url: "/app" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("app-marker");
  });

  it("serves the surface entry page for a deep client-side route (#59 SPA fallback)", async () => {
    // A hard refresh of a route that exists only inside the hydrated app must
    // get the entry page (so the client router can take over), not a 404.
    const admin = await app.inject({ method: "GET", url: "/admin/settings" });
    expect(admin.statusCode).toBe(200);
    expect(admin.headers["content-type"]).toContain("text/html");
    expect(admin.body).toContain("admin-marker");

    const appSurface = await app.inject({ method: "GET", url: "/app/time/today" });
    expect(appSurface.statusCode).toBe(200);
    expect(appSurface.headers["content-type"]).toContain("text/html");
    expect(appSurface.body).toContain("app-marker");
  });

  it("serves the surface entry page for the trailing-slash form (no redirect)", async () => {
    // With root-absolute asset paths there is no asset-resolution reason to
    // canonicalise; `/<surface>/` just falls through the `…/*` fallback.
    const admin = await app.inject({ method: "GET", url: "/admin/" });
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain("admin-marker");

    const appSurface = await app.inject({ method: "GET", url: "/app/" });
    expect(appSurface.statusCode).toBe(200);
    expect(appSurface.body).toContain("app-marker");
  });

  it("does not let the /admin fallback shadow shared root-level assets", async () => {
    // The fallback only owns the `/admin/*` and `/app/*` prefixes; the shared
    // hashed chunk lives at the root and must still be served as itself.
    const res = await app.inject({ method: "GET", url: "/_app/immutable/chunk.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(CHUNK_JS);
  });

  it("serves shared _app assets with a JS content-type", async () => {
    const res = await app.inject({ method: "GET", url: "/_app/immutable/chunk.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(CHUNK_JS);
    expect(res.headers["content-type"]).toContain("javascript");
  });

  it("answers HEAD on a surface URL", async () => {
    const res = await app.inject({ method: "HEAD", url: "/admin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("404s a non-GET method on a surface URL", async () => {
    const res = await app.inject({ method: "POST", url: "/admin" });
    expect(res.statusCode).toBe(404);
  });

  it("404s a non-GET method on a deep surface route (fallback is GET-only)", async () => {
    // The `…/*` fallback only registers `scope.get`, so a write verb to a deep
    // client-side path is not silently absorbed into the entry page.
    const res = await app.inject({ method: "POST", url: "/admin/settings" });
    expect(res.statusCode).toBe(404);
  });

  it("serves root-level static files (e.g. favicon.png)", async () => {
    const res = await app.inject({ method: "GET", url: "/favicon.png" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(FAVICON);
  });

  it("does not shadow the backend's own routes", async () => {
    const landing = await app.inject({ method: "GET", url: "/" });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toBe("hello, no policy yet");
    expect(landing.headers["content-type"]).toContain("text/plain");

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
  });

  it("404s an asset that does not exist in the build", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("frontend static mount (build absent)", () => {
  let app: FastifyInstance;
  let db: TestDb;
  const missingRoot = join(tmpdir(), "pct-frontend-does-not-exist-40");

  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  it("warns and skips the mount without blocking startup", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(msg: string) {
        lines.push(JSON.parse(msg) as Record<string, unknown>);
      },
    };
    db = testDb();
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "warn", PCT_FRONTEND_ROOT: missingRoot }),
      loggerStream: stream,
      db,
    });

    // The surfaces 404 because nothing is mounted...
    const admin = await app.inject({ method: "GET", url: "/admin" });
    expect(admin.statusCode).toBe(404);

    // ...but the backend's own routes still work.
    const landing = await app.inject({ method: "GET", url: "/" });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toBe("hello, no policy yet");

    const warning = lines.find((l) => l.component === "web/frontend");
    expect(warning).toBeDefined();
    expect(warning?.level).toBe(40); // pino "warn"
    expect(warning?.frontendRoot).toBe(missingRoot);
    expect(warning?.msg).toContain("not found");
  });
});
