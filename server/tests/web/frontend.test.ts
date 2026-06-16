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
  let root: string;

  beforeEach(() => {
    root = makeFixtureBuild();
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "silent", PCT_FRONTEND_ROOT: root }),
    });
  });

  afterEach(async () => {
    await app.close();
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

  it("redirects the trailing-slash form to the canonical surface URL", async () => {
    // The pages reference assets relatively (`./_app/…`); a redirect keeps the
    // browser at the slash-free URL so those resolve to `/_app/…`, not 404.
    const admin = await app.inject({ method: "GET", url: "/admin/" });
    expect(admin.statusCode).toBe(308);
    expect(admin.headers["location"]).toBe("/admin");

    const appSurface = await app.inject({ method: "GET", url: "/app/" });
    expect(appSurface.statusCode).toBe(308);
    expect(appSurface.headers["location"]).toBe("/app");
  });

  it("serves shared _app assets at their hashed path", async () => {
    const res = await app.inject({ method: "GET", url: "/_app/immutable/chunk.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(CHUNK_JS);
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
  const missingRoot = join(tmpdir(), "pct-frontend-does-not-exist-40");

  afterEach(async () => {
    await app.close();
  });

  it("warns and skips the mount without blocking startup", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(msg: string) {
        lines.push(JSON.parse(msg) as Record<string, unknown>);
      },
    };
    app = buildApp({
      settings: loadSettings({ PCT_LOG_LEVEL: "warn", PCT_FRONTEND_ROOT: missingRoot }),
      loggerStream: stream,
    });

    // The surfaces 404 because nothing is mounted...
    const admin = await app.inject({ method: "GET", url: "/admin" });
    expect(admin.statusCode).toBe(404);

    // ...but the backend's own routes still work.
    const landing = await app.inject({ method: "GET", url: "/" });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toBe("hello, no policy yet");

    const warning = lines.find((l) => l.component === "web/frontend" && typeof l.msg === "string");
    expect(warning).toBeDefined();
    expect(warning?.frontendRoot).toBe(missingRoot);
  });
});
