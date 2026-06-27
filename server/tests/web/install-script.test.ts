/**
 * Tests for GET /install-client.sh (#itoffd).
 *
 * Follows the same fixture pattern as frontend.test.ts: write a temporary
 * file, point `PCT_INSTALL_CLIENT_SCRIPT_PATH` at it, then exercise the route
 * via `app.inject()` — no sockets.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/web/app.js";
import { loadSettings } from "../../src/config.js";
import { testDb, type TestDb } from "../helpers/db.js";

const SCRIPT_CONTENT = "#!/usr/bin/env bash\necho 'install-client'\n";

describe("GET /install-client.sh (script present)", () => {
  let app: FastifyInstance;
  let db: TestDb;
  let scriptPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "pct-install-script-"));
    scriptPath = join(dir, "install-client.sh");
    writeFileSync(scriptPath, SCRIPT_CONTENT);
    db = testDb();
    app = buildApp({
      settings: loadSettings({
        PCT_LOG_LEVEL: "silent",
        PCT_INSTALL_CLIENT_SCRIPT_PATH: scriptPath,
      }),
      db,
    });
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
    rmSync(scriptPath, { force: true });
  });

  it("returns 200 with the script content", async () => {
    const res = await app.inject({ method: "GET", url: "/install-client.sh" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SCRIPT_CONTENT);
  });

  it("sets Content-Type to text/x-shellscript", async () => {
    const res = await app.inject({ method: "GET", url: "/install-client.sh" });
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
  });

  it("does not shadow other routes", async () => {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
  });
});

describe("GET /install-client.sh (script absent)", () => {
  let app: FastifyInstance;
  let db: TestDb;
  const missingPath = join(tmpdir(), "pct-install-script-does-not-exist.sh");

  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  it("404s and emits a startup warning", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(msg: string) {
        lines.push(JSON.parse(msg) as Record<string, unknown>);
      },
    };
    db = testDb();
    app = buildApp({
      settings: loadSettings({
        PCT_LOG_LEVEL: "warn",
        PCT_INSTALL_CLIENT_SCRIPT_PATH: missingPath,
      }),
      loggerStream: stream,
      db,
    });

    const res = await app.inject({ method: "GET", url: "/install-client.sh" });
    expect(res.statusCode).toBe(404);

    const warning = lines.find((l) => l.component === "web/install-script");
    expect(warning).toBeDefined();
    expect(warning?.level).toBe(40); // pino "warn"
    expect(warning?.installClientScriptPath).toBe(missingPath);
    expect(warning?.msg).toContain("not found");
  });

  it("does not block startup or affect other routes when absent", async () => {
    db = testDb();
    app = buildApp({
      settings: loadSettings({
        PCT_LOG_LEVEL: "silent",
        PCT_INSTALL_CLIENT_SCRIPT_PATH: missingPath,
      }),
      db,
    });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  });
});
