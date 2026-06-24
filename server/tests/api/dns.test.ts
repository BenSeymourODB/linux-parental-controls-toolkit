/**
 * HTTP tests for the DNS-status read route `GET /api/dns` (#95), driven through
 * the real app via `app.inject()` with a genuine admin session cookie — per
 * docs/testing.md → "HTTP routes". Covers the anonymous-401 guard and the
 * serialised snapshot for each mode, with an injected {@link AdGuardService}
 * (fake `fetch`) so the `onReady` preflight makes no network call.
 */
import { afterEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings, type Settings } from "../../src/config.js";
import {
  createAdGuardService,
  type AdGuardService,
  type FetchLike,
} from "../../src/transport/adguard/index.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function configuredSettings() {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "dns-test-secret",
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

function statusFetch(running: boolean): FetchLike {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ version: "v0.107.0", running, protection_enabled: true }),
    });
}

/** Build the test app around an injected AdGuard service and log in as admin. */
async function harnessWith(adguard: AdGuardService): Promise<{ harness: TestApp; cookie: string }> {
  const harness = buildTestApp({ appOptions: { settings: configuredSettings(), adguard } });
  await harness.app.ready(); // triggers the onReady preflight
  const login = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "ben", password: "hunter2" },
  });
  return { harness, cookie: sessionCookie(login) };
}

describe("GET /api/dns", () => {
  let harness: TestApp | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("rejects anonymous access with a 401 envelope", async () => {
    const built = await harnessWith(createAdGuardService({ mode: "disabled" }));
    harness = built.harness;
    const res = await harness.app.inject({ method: "GET", url: "/api/dns" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("surfaces disabled mode as not_applicable", async () => {
    const built = await harnessWith(createAdGuardService({ mode: "disabled" }));
    harness = built.harness;
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/dns",
      headers: { cookie: built.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: "disabled",
      configured: false,
      health: "not_applicable",
      baseUrl: null,
      checkedAt: null,
      detail: null,
    });
  });

  it("surfaces a healthy external instance as ok after the startup preflight", async () => {
    const adguard = createAdGuardService(external(), {
      fetch: statusFetch(true),
      readSecretFile: () => Promise.resolve("token"),
    });
    const built = await harnessWith(adguard);
    harness = built.harness;
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/dns",
      headers: { cookie: built.cookie },
    });
    const body = res.json();
    expect(body.mode).toBe("external");
    expect(body.configured).toBe(true);
    expect(body.health).toBe("ok");
    expect(body.baseUrl).toBe(URL);
    expect(typeof body.checkedAt).toBe("string");
  });

  it("surfaces an unreachable external instance loudly via the status (not a crash)", async () => {
    const adguard = createAdGuardService(external(), {
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      readSecretFile: () => Promise.resolve("token"),
    });
    const built = await harnessWith(adguard);
    harness = built.harness;
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/dns",
      headers: { cookie: built.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.health).toBe("unreachable");
    expect(body.detail).toBeTypeOf("string");
  });

  it("surfaces managed mode as unknown, deferring to the supervisor (#96)", async () => {
    const built = await harnessWith(
      createAdGuardService({
        mode: "managed",
        bindAddr: "0.0.0.0:53",
        adminPort: 3000,
        dataDir: "/data/adguard",
      }),
    );
    harness = built.harness;
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/dns",
      headers: { cookie: built.cookie },
    });
    const body = res.json();
    expect(body.mode).toBe("managed");
    expect(body.health).toBe("unknown");
    expect(body.detail).toContain("#96");
  });
});
