/**
 * HTTP tests for the per-client DNS blocklist routes (#97):
 * `GET /api/dns/blocklist` (preview) and `POST /api/dns/blocklist/apply`.
 * Driven through the real app via `app.inject()` with a genuine admin cookie
 * (docs/testing.md → "HTTP routes"). The AdGuard instance is a routing fake
 * `fetch`; the composition mechanics themselves are unit-tested in
 * `transport/adguard/blocklist.test.ts`.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings, type Settings } from "../../src/config.js";
import {
  createActivity,
  createClient,
  createSchedule,
  createUser,
  upsertLink,
} from "../../src/policy/repository.js";
import { clients as clientsTable } from "../../src/policy/schema.js";
import {
  createAdGuardService,
  type AdGuardService,
  type FetchLike,
} from "../../src/transport/adguard/index.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import type { TestDb } from "../helpers/db.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "dns-blocklist-secret",
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

const URL = "http://adguard.lan";

function external(): Settings["adguard"] {
  return { mode: "external", url: URL, apiTokenFile: "/run/secrets/token" };
}

interface AdGuardState {
  clients: { name: string; ids: string[] }[];
  userRules: string[];
}

/** A routing fake AdGuard REST surface over an in-memory {@link AdGuardState}. */
function routingFetch(state: AdGuardState): FetchLike {
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(body) });
  return (input, init) => {
    const url = String(input);
    const path = url.slice(url.indexOf("/control"));
    const method = init?.method ?? "GET";
    const parsed: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    if (path === "/control/status") {
      return ok({ version: "v0.107.0", running: true, protection_enabled: true });
    }
    if (path === "/control/clients" && method === "GET") {
      return ok({ clients: state.clients });
    }
    if (path === "/control/clients/add") {
      const body = parsed as { name: string; ids: string[] };
      state.clients.push({ name: body.name, ids: body.ids });
      return ok({});
    }
    if (path === "/control/clients/update") {
      const body = parsed as { name: string; data: { name: string; ids: string[] } };
      state.clients = state.clients.map((c) =>
        c.name === body.name ? { name: body.data.name, ids: body.data.ids } : c,
      );
      return ok({});
    }
    if (path === "/control/clients/delete") {
      const body = parsed as { name: string };
      state.clients = state.clients.filter((c) => c.name !== body.name);
      return ok({});
    }
    if (path === "/control/filtering/status") {
      return ok({ enabled: true, user_rules: state.userRules });
    }
    if (path === "/control/filtering/set_rules") {
      state.userRules = (parsed as { rules: string[] }).rules;
      return ok({});
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: () => Promise.resolve({}),
    });
  };
}

/** Build the test app around an injected AdGuard service and log in as admin. */
async function harnessWith(
  adguard: AdGuardService,
): Promise<{ harness: TestApp; cookie: string; db: TestDb }> {
  const harness = buildTestApp({ appOptions: { settings: configuredSettings(), adguard } });
  await harness.app.ready(); // triggers the onReady preflight
  const login = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "ben", password: "hunter2" },
  });
  return { harness, cookie: sessionCookie(login), db: harness.db };
}

/** Seed a device (client) with reported IPs and a supervised user denying `domains`. */
function seedDevice(
  db: TestDb,
  opts: { hostname: string; friendlyName?: string; ips?: string[]; domains: string[] },
): void {
  const clientId = createClient(db, {
    hostname: opts.hostname,
    sshUser: "pct-agent",
    ...(opts.friendlyName !== undefined ? { friendlyName: opts.friendlyName } : {}),
  }).id;
  if (opts.ips !== undefined) {
    db.update(clientsTable)
      .set({ reportedIps: opts.ips })
      .where(eq(clientsTable.id, clientId))
      .run();
  }
  const userId = createUser(db, { displayName: opts.hostname }).id;
  upsertLink(db, userId, clientId, { osUsername: "child", osUserRef: "1001" });
  for (const domain of opts.domains) {
    const activity = createActivity(db, { kind: "domain", matcher: domain });
    createSchedule(db, { userId, targetKind: "activity", targetId: activity.id, action: "deny" });
  }
}

describe("GET /api/dns/blocklist", () => {
  let harness: TestApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("rejects anonymous access with a 401 envelope", async () => {
    const built = await harnessWith(createAdGuardService({ mode: "disabled" }));
    harness = built.harness;
    const res = await harness.app.inject({ method: "GET", url: "/api/dns/blocklist" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("previews the plan in disabled mode as not applyable, still computing it", async () => {
    const built = await harnessWith(createAdGuardService({ mode: "disabled" }));
    harness = built.harness;
    seedDevice(built.db, {
      hostname: "mint-01",
      friendlyName: "Alice",
      ips: ["192.168.1.50"],
      domains: ["youtube.com"],
    });
    seedDevice(built.db, { hostname: "mint-03", domains: ["tiktok.com"] });

    const res = await harness.app.inject({
      method: "GET",
      url: "/api/dns/blocklist",
      headers: { cookie: built.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("disabled");
    expect(body.applyable).toBe(false);
    expect(body.detail).toBeTypeOf("string");
    expect(body.clients).toEqual([
      { name: "pct:Alice", ids: ["192.168.1.50"], domains: ["youtube.com"] },
    ]);
    expect(body.skipped).toEqual([
      {
        clientId: expect.any(Number),
        name: "pct:mint-03",
        label: "mint-03",
        reason: "no_reported_ips",
        domains: ["tiktok.com"],
      },
    ]);
  });

  it("is applyable against a healthy external instance", async () => {
    const adguard = createAdGuardService(external(), {
      fetch: routingFetch({ clients: [], userRules: [] }),
      readSecretFile: () => Promise.resolve("token"),
    });
    const built = await harnessWith(adguard);
    harness = built.harness;
    seedDevice(built.db, {
      hostname: "mint-01",
      friendlyName: "Alice",
      ips: ["192.168.1.50"],
      domains: ["youtube.com"],
    });

    const res = await harness.app.inject({
      method: "GET",
      url: "/api/dns/blocklist",
      headers: { cookie: built.cookie },
    });

    const body = res.json();
    expect(body.mode).toBe("external");
    expect(body.applyable).toBe(true);
    expect(body.detail).toBeNull();
    expect(body.clients).toHaveLength(1);
  });
});

describe("POST /api/dns/blocklist/apply", () => {
  let harness: TestApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("rejects anonymous access with a 401 envelope", async () => {
    const built = await harnessWith(createAdGuardService({ mode: "disabled" }));
    harness = built.harness;
    const res = await harness.app.inject({ method: "POST", url: "/api/dns/blocklist/apply" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 409 when DNS filtering is disabled", async () => {
    const built = await harnessWith(createAdGuardService({ mode: "disabled" }));
    harness = built.harness;
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/dns/blocklist/apply",
      headers: { cookie: built.cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("dns_not_applyable");
  });

  it("reconciles clients and pushes rules against a healthy external instance", async () => {
    const state: AdGuardState = { clients: [], userRules: ["||foreign.com^"] };
    const adguard = createAdGuardService(external(), {
      fetch: routingFetch(state),
      readSecretFile: () => Promise.resolve("token"),
    });
    const built = await harnessWith(adguard);
    harness = built.harness;
    seedDevice(built.db, {
      hostname: "mint-01",
      friendlyName: "Alice",
      ips: ["192.168.1.50"],
      domains: ["youtube.com"],
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/dns/blocklist/apply",
      headers: { cookie: built.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      clientsManaged: 1,
      skipped: 0,
      ruleCount: 1,
      rulesChanged: true,
      clients: { added: 1, updated: 0, deleted: 0, unchanged: 0 },
    });
    expect(state.clients).toEqual([{ name: "pct:Alice", ids: ["192.168.1.50"] }]);
    expect(state.userRules).toContain("||foreign.com^");
    expect(state.userRules).toContain("||youtube.com^$client='pct:Alice'");
  });
});
