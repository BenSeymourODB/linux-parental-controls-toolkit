/**
 * Tests for the managed timekpr-next mirror serving routes (#393).
 *
 * Follows the install-script.test.ts fixture pattern: materialise a temp mirror
 * data dir (a fake `.deb` + the version sentinel #392 writes), point
 * `PCT_TIMEKPR_MIRROR_DIR` at it in `managed` mode, and exercise the routes via
 * `app.inject()` — no sockets. Covers the served `.deb` + manifest, the cold
 * start 404, traversal/sentinel/non-`.deb` rejection, and that disabled/external
 * modes expose no mirror surface at all.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { loadSettings } from "../../src/config.js";
import { VERSION_SENTINEL } from "../../src/transport/timekpr-mirror/index.js";
import { buildApp } from "../../src/web/app.js";
import { testDb, type TestDb } from "../helpers/db.js";

const VERSION = "0.5.5";
const DEB_FILENAME = `timekpr-next_${VERSION}_all.deb`;
/** A minimal valid `.deb`: the Debian ar global header followed by content. */
const DEB_BYTES = Buffer.concat([Buffer.from("!<arch>\n", "ascii"), Buffer.from("payload")]);

function buildManagedApp(dataDir: string, db: TestDb): FastifyInstance {
  return buildApp({
    settings: loadSettings({
      PCT_LOG_LEVEL: "silent",
      PCT_TIMEKPR_MIRROR: "managed",
      PCT_TIMEKPR_MIRROR_DIR: dataDir,
    }),
    db,
  });
}

describe("GET /apt/timekpr/* (managed mode, package cached)", () => {
  let app: FastifyInstance;
  let db: TestDb;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-timekpr-mirror-"));
    writeFileSync(join(dir, DEB_FILENAME), DEB_BYTES);
    writeFileSync(join(dir, VERSION_SENTINEL), `${VERSION}\n`);
    db = testDb();
    app = buildManagedApp(dir, db);
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams the cached .deb with the Debian content type", async () => {
    const res = await app.inject({ method: "GET", url: `/apt/timekpr/${DEB_FILENAME}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.debian.binary-package");
    expect(res.rawPayload.equals(DEB_BYTES)).toBe(true);
  });

  it("serves a manifest describing the cached package", async () => {
    const res = await app.inject({ method: "GET", url: "/apt/timekpr/manifest.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      package: "timekpr-next",
      version: VERSION,
      filename: DEB_FILENAME,
    });
  });

  it("404s a filename that is not on disk", async () => {
    const res = await app.inject({ method: "GET", url: "/apt/timekpr/timekpr-next_9.9.9_all.deb" });
    expect(res.statusCode).toBe(404);
  });

  it("404s a non-.deb filename (e.g. the version sentinel)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/apt/timekpr/${encodeURIComponent(VERSION_SENTINEL)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s a traversal-shaped filename", async () => {
    // Fastify params never span '/', and the allow-list rejects a leading dot;
    // an encoded traversal segment still resolves to a single param value.
    const res = await app.inject({ method: "GET", url: "/apt/timekpr/..%2f..%2fpolicy.sqlite" });
    expect(res.statusCode).toBe(404);
  });

  it("does not shadow other routes", async () => {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
  });
});

describe("GET /apt/timekpr/* (managed mode, cold start — nothing cached)", () => {
  let app: FastifyInstance;
  let db: TestDb;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pct-timekpr-mirror-cold-"));
    db = testDb();
    app = buildManagedApp(dir, db);
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("404s the manifest before the first fetch, with a JSON body", async () => {
    const res = await app.inject({ method: "GET", url: "/apt/timekpr/manifest.json" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({ error: "no timekpr package is cached yet" });
  });

  it("404s a well-formed .deb name that is not cached yet", async () => {
    const res = await app.inject({ method: "GET", url: `/apt/timekpr/${DEB_FILENAME}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /apt/timekpr/* (mirror not managed)", () => {
  let app: FastifyInstance;
  let db: TestDb;

  afterEach(async () => {
    await app.close();
    db.$client.close();
  });

  it("exposes no mirror surface when disabled (default)", async () => {
    db = testDb();
    app = buildApp({ settings: loadSettings({ PCT_LOG_LEVEL: "silent" }), db });
    const manifest = await app.inject({ method: "GET", url: "/apt/timekpr/manifest.json" });
    expect(manifest.statusCode).toBe(404);
    const file = await app.inject({ method: "GET", url: `/apt/timekpr/${DEB_FILENAME}` });
    expect(file.statusCode).toBe(404);
  });

  it("exposes no mirror surface in external mode (client points apt elsewhere)", async () => {
    db = testDb();
    app = buildApp({
      settings: loadSettings({
        PCT_LOG_LEVEL: "silent",
        PCT_TIMEKPR_MIRROR: "external",
        PCT_TIMEKPR_MIRROR_URL: "https://apt.lan/timekpr",
      }),
      db,
    });
    const manifest = await app.inject({ method: "GET", url: "/apt/timekpr/manifest.json" });
    expect(manifest.statusCode).toBe(404);
  });
});
