/**
 * HTTP tests for the transport-audit read route `GET /api/audit` (#85), driven
 * through the real app via `app.inject()` with a genuine admin session cookie —
 * per docs/testing.md → "HTTP routes". Covers the anonymous-401 guard, the
 * happy path (newest-first), the filters, limit + cursor, and validation 400s.
 *
 * Rows are seeded with the same `DrizzleAuditSink` the transport uses, against
 * the harness DB, so the route reads exactly what the recorder writes.
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings } from "../../src/config.js";
import type { AuditOutcome } from "../../src/policy/enums.js";
import { clients } from "../../src/policy/schema.js";
import type { AuditEntry } from "../../src/transport/audit/recorder.js";
import { DrizzleAuditSink } from "../../src/transport/audit/sink.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "audit-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

const TARGET = { host: "client.local", port: 22, username: "pct-agent" };

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    target: TARGET,
    command: ["sudo", "timekpra", "--userinfo", "alice"],
    outcome: "ok",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    errorMessage: null,
    context: {},
    ...overrides,
  };
}

describe("GET /api/audit", () => {
  let harness: TestApp;
  let cookie: string;
  let sink: DrizzleAuditSink;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: configuredSettings() } });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    cookie = sessionCookie(login);
    sink = new DrizzleAuditSink(harness.db);
    // The audit client_id FK requires real client rows (foreign_keys is ON).
    for (const id of [1, 2]) {
      harness.db
        .insert(clients)
        .values({ id, hostname: `box${id}`, sshUser: "pct-agent" })
        .run();
    }
  });

  afterEach(async () => {
    await harness.close();
  });

  function auth(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  function seed(n: number, build: (i: number) => Partial<AuditEntry> = () => ({})): void {
    for (let i = 0; i < n; i += 1) sink.record(entry(build(i)));
  }

  it("rejects anonymous access with a 401 envelope", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("returns entries newest-first with a null cursor when not a full page", async () => {
    seed(3, (i) => ({ context: { reason: `r${i}` } }));
    const res = await auth({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: { reason: string }) => e.reason)).toEqual(["r2", "r1", "r0"]);
    expect(body.nextCursor).toBeNull();
    // The wire shape serialises `at` as an ISO string and `command` as an array.
    expect(typeof body.entries[0].at).toBe("string");
    expect(body.entries[0].command).toEqual(["sudo", "timekpra", "--userinfo", "alice"]);
  });

  it("paginates: a full page returns the oldest id as nextCursor", async () => {
    seed(5, (i) => ({ context: { reason: `r${i}` } }));
    const first = await auth({ method: "GET", url: "/api/audit?limit=2" });
    const firstBody = first.json();
    expect(firstBody.entries.map((e: { reason: string }) => e.reason)).toEqual(["r4", "r3"]);
    expect(firstBody.nextCursor).toBe(firstBody.entries[1].id);

    const second = await auth({
      method: "GET",
      url: `/api/audit?limit=2&before=${firstBody.nextCursor}`,
    });
    expect(second.json().entries.map((e: { reason: string }) => e.reason)).toEqual(["r2", "r1"]);
  });

  it("returns an empty page with a null cursor past the end of the log", async () => {
    seed(2, (i) => ({ context: { reason: `r${i}` } }));
    const all = await auth({ method: "GET", url: "/api/audit" });
    const oldestId = all.json().entries.at(-1).id;
    const past = await auth({ method: "GET", url: `/api/audit?before=${oldestId}` });
    const body = past.json();
    expect(body.entries).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("filters by clientId", async () => {
    sink.record(entry({ context: { clientId: 1 } }));
    sink.record(entry({ context: { clientId: 2 } }));
    const res = await auth({ method: "GET", url: "/api/audit?clientId=2" });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].clientId).toBe(2);
  });

  it("filters by outcome", async () => {
    const outcomes: AuditOutcome[] = ["ok", "failed", "ok"];
    for (const outcome of outcomes) sink.record(entry({ outcome }));
    const res = await auth({ method: "GET", url: "/api/audit?outcome=failed" });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].outcome).toBe("failed");
  });

  it("rejects an unknown outcome with a 400 validation envelope", async () => {
    const res = await auth({ method: "GET", url: "/api/audit?outcome=bogus" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects a limit over the maximum", async () => {
    const res = await auth({ method: "GET", url: "/api/audit?limit=500" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-positive limit", async () => {
    const res = await auth({ method: "GET", url: "/api/audit?limit=0" });
    expect(res.statusCode).toBe(400);
  });
});
