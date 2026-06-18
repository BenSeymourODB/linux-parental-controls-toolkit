/**
 * HTTP tests for the client-enrolment routes (#77), driven through the real app
 * via `app.inject()`. Covers the admin-guarded token mint, the token-
 * authenticated enrol exchange, and the failure matrix (anonymous mint, bad
 * userId, missing/invalid/expired/used bearer, user-set mismatch, duplicate
 * hostname) — per docs/testing.md → "HTTP routes".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseBearer } from "../../src/api/clients/routes.js";
import { hashToken } from "../../src/auth/secret-token.js";
import { SESSION_COOKIE } from "../../src/auth/session.js";
import { loadSettings, type Settings } from "../../src/config.js";
import { enrolmentTokens } from "../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";

function settingsWith(env: Record<string, string> = {}): Settings {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "enrol-test-secret",
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

describe("parseBearer", () => {
  it("extracts a bearer token, and rejects missing/malformed/empty headers", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Basic abc123")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
    expect(parseBearer("Bearer    ")).toBeNull();
  });
});

describe("client enrolment routes", () => {
  let harness: TestApp;
  let cookie: string;
  let tmpDir: string;

  async function start(settings: Settings): Promise<void> {
    harness = buildTestApp({ appOptions: { settings } });
    await harness.app.ready();
    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    cookie = sessionCookie(login);
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pct-enrol-"));
    await start(settingsWith());
  });

  afterEach(async () => {
    await harness.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Inject with the admin session cookie attached. */
  function admin(opts: InjectOptions) {
    return harness.app.inject({ ...opts, headers: { ...opts.headers, cookie } });
  }

  /** Create a policy user and return its id. */
  async function createUser(displayName: string): Promise<number> {
    const res = await admin({ method: "POST", url: "/api/users", payload: { displayName } });
    return res.json().id as number;
  }

  /** Mint a token for one user mapped to `linuxUsername`; returns the plaintext token. */
  async function mintFor(userId: number, linuxUsername = "alice"): Promise<string> {
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: { supervisedUsers: [{ userId, linuxUsername }] },
    });
    expect(res.statusCode).toBe(201);
    return res.json().token as string;
  }

  function enrol(token: string | null, payload: Record<string, unknown>) {
    const opts: InjectOptions = { method: "POST", url: "/api/clients/enrol", payload };
    if (token !== null) opts.headers = { authorization: `Bearer ${token}` };
    return harness.app.inject(opts);
  }

  // --- mint (admin-guarded) ------------------------------------------------

  it("rejects an anonymous mint with 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: { supervisedUsers: [{ userId: 1, linuxUsername: "alice" }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("404s a mint that references a non-existent user", async () => {
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: { supervisedUsers: [{ userId: 9999, linuxUsername: "ghost" }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("400s a mint with duplicate linux usernames", async () => {
    const userId = await createUser("Alice");
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: {
        supervisedUsers: [
          { userId, linuxUsername: "alice" },
          { userId, linuxUsername: "alice" },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("mints a token (201) storing only its hash", async () => {
    const userId = await createUser("Alice");
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: { supervisedUsers: [{ userId, linuxUsername: "alice" }] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe("string");
    expect(typeof body.id).toBe("number");
    expect(typeof body.expiresAt).toBe("string");

    // Persisted as a hash, never the plaintext.
    const stored = harness.db.select().from(enrolmentTokens).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hashToken(body.token));
    expect(stored[0]?.tokenHash).not.toBe(body.token);
  });

  // --- enrol (token-authenticated) -----------------------------------------

  it("401s an enrol with no bearer header", async () => {
    const res = await enrol(null, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("401s an enrol with an unknown token", async () => {
    const res = await enrol("not-a-real-token", {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("enrolment_token_invalid");
  });

  it("enrols a client (201): creates the client + link, returns a bearer token", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.clientId).toBe("number");
    expect(typeof body.bearerToken).toBe("string");
    expect(body.sshPublicKey).toBeNull(); // no key file configured here
    expect(body.supervisedUsers).toEqual([{ userId, linuxUsername: "alice", linuxUid: 1000 }]);

    // The client now shows up in the admin inventory with its link.
    const links = await admin({ method: "GET", url: `/api/users/${userId}/clients` });
    expect(links.json()).toEqual([
      { userId, clientId: body.clientId, linuxUsername: "alice", linuxUid: 1000 },
    ]);
  });

  it("401s reuse of a consumed token (single-use)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const payload = {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    };
    expect((await enrol(token, payload)).statusCode).toBe(201);

    const second = await enrol(token, { ...payload, hostname: "mint-02" });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe("enrolment_token_used");
  });

  it("400s an enrol whose supervised-user set doesn't match the token", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "bob", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("enrolment_user_mismatch");
  });

  it("409s an enrol whose hostname is already enrolled", async () => {
    const userId = await createUser("Alice");
    const t1 = await mintFor(userId, "alice");
    const payload = {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    };
    expect((await enrol(t1, payload)).statusCode).toBe(201);

    // Fresh token, same hostname → 409 conflict.
    const t2 = await mintFor(userId, "alice");
    const res = await enrol(t2, { ...payload, supervisedUsers: payload.supervisedUsers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
  });

  it("returns the server SSH public key when one is configured", async () => {
    await harness.close();
    const keyPath = join(tmpDir, "id_ed25519.pub");
    writeFileSync(keyPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 dashboard@pct\n");
    await start(settingsWith({ PCT_SSH_PUBLIC_KEY_PATH: keyPath }));

    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sshPublicKey).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 dashboard@pct");
  });

  it("still enrols (sshPublicKey null) when the configured key path is unreadable", async () => {
    // Point the key path at a directory: readFileSync throws EISDIR (not the
    // expected ENOENT), which the service logs and degrades to null rather than
    // failing the enrolment.
    await harness.close();
    await start(settingsWith({ PCT_SSH_PUBLIC_KEY_PATH: tmpDir }));

    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sshPublicKey).toBeNull();
  });

  it("409s an enrol when a bound user was deleted after the token was minted", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    // Admin deletes the policy user between mint and enrol.
    expect((await admin({ method: "DELETE", url: `/api/users/${userId}` })).statusCode).toBe(204);

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("user_no_longer_exists");
  });

  it("400s a mint whose ttlSeconds exceeds the maximum", async () => {
    const userId = await createUser("Alice");
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: {
        supervisedUsers: [{ userId, linuxUsername: "alice" }],
        ttlSeconds: 24 * 60 * 60 + 1,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("applies the default 1h TTL when ttlSeconds is omitted", async () => {
    const userId = await createUser("Alice");
    const before = Date.now();
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: { supervisedUsers: [{ userId, linuxUsername: "alice" }] },
    });
    const expiresAt = new Date(res.json().expiresAt as string).getTime();
    // ~1h out (allow a generous window for execution + second-granularity).
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000 - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000 + 5_000);
  });

  it("400s an enrol with an empty supervisedUsers list", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  describe("multi-user mappings (the bijection check)", () => {
    /** Mint a token bound to two users; returns [token, aliceId, bobId]. */
    async function mintTwo(): Promise<[string, number, number]> {
      const aliceId = await createUser("Alice");
      const bobId = await createUser("Bob");
      const res = await admin({
        method: "POST",
        url: "/api/clients/enrolment-tokens",
        payload: {
          supervisedUsers: [
            { userId: aliceId, linuxUsername: "alice" },
            { userId: bobId, linuxUsername: "bob" },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      return [res.json().token as string, aliceId, bobId];
    }

    it("enrols both users (201) mapping each minted userId to its uid", async () => {
      const [token, aliceId, bobId] = await mintTwo();
      const res = await enrol(token, {
        hostname: "mint-01",
        sshUser: "pct-agent",
        supervisedUsers: [
          { linuxUsername: "alice", linuxUid: 1000 },
          { linuxUsername: "bob", linuxUid: 1001 },
        ],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().supervisedUsers).toEqual([
        { userId: aliceId, linuxUsername: "alice", linuxUid: 1000 },
        { userId: bobId, linuxUsername: "bob", linuxUid: 1001 },
      ]);
    });

    it("400s when a bound user is dropped from the enrol request", async () => {
      const [token] = await mintTwo();
      const res = await enrol(token, {
        hostname: "mint-01",
        sshUser: "pct-agent",
        supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("enrolment_user_mismatch");
    });

    it("400s when the enrol request smuggles in an unbound user", async () => {
      const [token] = await mintTwo();
      const res = await enrol(token, {
        hostname: "mint-01",
        sshUser: "pct-agent",
        supervisedUsers: [
          { linuxUsername: "alice", linuxUid: 1000 },
          { linuxUsername: "carol", linuxUid: 1002 },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("enrolment_user_mismatch");
    });
  });

  it("401s an enrol with an expired token", async () => {
    // Mint a token then fast-forward past its TTL by writing expiry into the past.
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    harness.db
      .update(enrolmentTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ linuxUsername: "alice", linuxUid: 1000 }],
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("enrolment_token_expired");
  });
});
