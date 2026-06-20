/**
 * HTTP tests for the integration-token management routes (#114), driven through
 * the real app via `app.inject()`. Covers the admin-guarded mint/list/revoke,
 * the show-once secret, and the failure matrix (anonymous, bad scope, duplicate
 * name) — per `docs/testing.md` → "HTTP routes".
 */
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../../src/auth/session.js";
import { loadSettings, type Settings } from "../../../src/config.js";
import { buildTestApp, type TestApp } from "../../helpers/app.js";

function settingsWith(env: Record<string, string> = {}): Settings {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "integration-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
    ...env,
  });
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

describe("integration-token routes", () => {
  let harness: TestApp;
  let cookie: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: settingsWith() } });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    cookie = sessionCookie(login);
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Inject with the admin session cookie attached. */
  function admin(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  async function mint(name: string, scopes: string[]) {
    return admin({
      method: "POST",
      url: "/api/integrations/tokens",
      payload: { name, scopes },
    });
  }

  it("mints a token, returning the plaintext secret once", async () => {
    const res = await mint("calendar", ["grants:write"]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("calendar");
    expect(body.scopes).toEqual(["grants:write"]);
    expect(typeof body.secret).toBe("string");
    expect(body.secret.length).toBeGreaterThan(0);
  });

  it("lists tokens without ever exposing the secret", async () => {
    await mint("calendar", ["grants:write", "policy:read"]);
    const res = await admin({ method: "GET", url: "/api/integrations/tokens" });
    expect(res.statusCode).toBe(200);
    const [summary] = res.json();
    expect(summary.name).toBe("calendar");
    expect(summary.scopes).toEqual(["grants:write", "policy:read"]);
    expect(summary.revokedAt).toBeNull();
    expect("secret" in summary).toBe(false);
    expect("hashedSecret" in summary).toBe(false);
  });

  it("revokes a token, after which the list shows it revoked", async () => {
    const id = (await mint("calendar", ["grants:write"])).json().id as number;
    const revoke = await admin({
      method: "POST",
      url: `/api/integrations/tokens/${id}/revoke`,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedAt).not.toBeNull();

    const list = await admin({ method: "GET", url: "/api/integrations/tokens" });
    expect(list.json()[0].revokedAt).not.toBeNull();
  });

  it("404s revoking an unknown token", async () => {
    const res = await admin({ method: "POST", url: "/api/integrations/tokens/9999/revoke" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an unknown scope with a 400", async () => {
    const res = await mint("calendar", ["grants:write", "bogus:scope"]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects a duplicate name with a 409", async () => {
    expect((await mint("calendar", ["grants:write"])).statusCode).toBe(201);
    const dup = await mint("calendar", ["policy:read"]);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("conflict");
  });

  it("requires an admin session for every route", async () => {
    const app = harness.app;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/integrations/tokens",
          payload: { name: "x", scopes: ["grants:write"] },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/integrations/tokens" })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: "POST", url: "/api/integrations/tokens/1/revoke" })).statusCode,
    ).toBe(401);
  });
});
