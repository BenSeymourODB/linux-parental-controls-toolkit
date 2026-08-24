/**
 * HTTP tests for the client-enrolment routes (#77), driven through the real app
 * via `app.inject()`. Covers the admin-guarded token mint, the token-
 * authenticated enrol exchange, and the failure matrix (anonymous mint, bad
 * userId, missing/invalid/expired/used bearer, user-set mismatch, duplicate
 * hostname) — per docs/testing.md → "HTTP routes".
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENROL_RATE_LIMIT_MAX_ATTEMPTS } from "../../src/api/clients/routes.js";
import { hashToken } from "../../src/auth/secret-token.js";
import { SESSION_COOKIE } from "../../src/auth/session.js";
import { VERSION_SENTINEL } from "../../src/transport/timekpr-mirror/index.js";
import { loadSettings, type Settings } from "../../src/config.js";
import { clients, enrolmentTokens } from "../../src/policy/schema.js";
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

  /** Mint a token for one user mapped to `osUsername`; returns the plaintext token. */
  async function mintFor(userId: number, osUsername = "alice"): Promise<string> {
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: { supervisedUsers: [{ userId, osUsername }] },
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
      payload: { supervisedUsers: [{ userId: 1, osUsername: "alice" }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("404s a mint that references a non-existent user", async () => {
    const res = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: { supervisedUsers: [{ userId: 9999, osUsername: "ghost" }] },
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
          { userId, osUsername: "alice" },
          { userId, osUsername: "alice" },
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
      payload: { supervisedUsers: [{ userId, osUsername: "alice" }] },
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
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("401s an enrol with an unknown token", async () => {
    const res = await enrol("not-a-real-token", {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
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
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.clientId).toBe("number");
    expect(typeof body.bearerToken).toBe("string");
    expect(body.sshPublicKey).toBeNull(); // no key file configured here
    expect(body.supervisedUsers).toEqual([{ userId, osUsername: "alice", osUserRef: "1000" }]);
    // Every enrolment is `linux` for now (#229); the request never sets platform.
    expect(body.platform).toBe("linux");

    // The client now shows up in the admin inventory with its link.
    const links = await admin({ method: "GET", url: `/api/users/${userId}/clients` });
    expect(links.json()).toEqual([
      { userId, clientId: body.clientId, osUsername: "alice", osUserRef: "1000" },
    ]);
  });

  it("advertises a disabled timekpr mirror by default (#393)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().timekprMirror).toEqual({ mode: "disabled" });
  });

  it("advertises the managed mirror coordinates + cached version at enrol (#393)", async () => {
    // Restart the app in managed mode over a data dir that already holds a
    // cached .deb + version sentinel (as the refresh job #392 would leave it).
    await harness.close();
    const mirrorDir = join(tmpDir, "apt-timekpr");
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, "timekpr-next_0.5.5_all.deb"), "!<arch>\npayload");
    writeFileSync(join(mirrorDir, VERSION_SENTINEL), "0.5.5\n");
    await start(settingsWith({ PCT_TIMEKPR_MIRROR: "managed", PCT_TIMEKPR_MIRROR_DIR: mirrorDir }));

    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().timekprMirror).toEqual({
      mode: "managed",
      aptPath: "/apt/timekpr",
      package: "timekpr-next",
      version: "0.5.5",
      debFilename: "timekpr-next_0.5.5_all.deb",
    });
  });

  it("records reported component versions at enrolment and echoes them back (#164)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
      agentVersion: "1.4.0",
      componentVersions: { timekpr: "0.5.3", activitywatch: "0.13.2" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agentVersion).toBe("1.4.0");
    expect(body.componentVersions).toEqual({ timekpr: "0.5.3", activitywatch: "0.13.2" });

    // The inventory is persisted, with a report timestamp set.
    const stored = harness.db.select().from(clients).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.agentVersion).toBe("1.4.0");
    expect(stored[0]?.componentVersions).toEqual({ timekpr: "0.5.3", activitywatch: "0.13.2" });
    expect(stored[0]?.versionsReportedAt).toBeInstanceOf(Date);
  });

  it("leaves the version inventory null when the client reports none (#164)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agentVersion).toBeNull();
    expect(body.componentVersions).toBeNull();

    const stored = harness.db.select().from(clients).all();
    expect(stored[0]?.versionsReportedAt).toBeNull();
  });

  it("400s an enrol whose reported version is malformed (#164)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
      componentVersions: { timekpr: 'bad" version' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  // --- enrolment metadata (#355) -------------------------------------------

  /** The Clients-health card for `clientId`, or undefined. */
  async function cardFor(clientId: number): Promise<Record<string, unknown> | undefined> {
    const health = await admin({ method: "GET", url: "/api/clients/health" });
    return (health.json() as Record<string, unknown>[]).find((c) => c.clientId === clientId);
  }

  it("records self-reported IPs and the observed source IP at enrol (#355)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");

    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
      reportedIps: ["192.168.1.42", "fe80::1"],
    });
    expect(res.statusCode).toBe(201);

    const stored = harness.db.select().from(clients).all();
    expect(stored[0]?.reportedIps).toEqual(["192.168.1.42", "fe80::1"]);
    // app.inject presents a loopback peer; with trustProxy off (the test
    // default) that socket peer is the observed source IP verbatim — no
    // X-Forwarded-For is trusted.
    expect(stored[0]?.sourceIp).toBe("127.0.0.1");

    // Both surface on the Clients health card.
    const card = await cardFor(res.json().clientId as number);
    expect(card?.reportedIps).toEqual(["192.168.1.42", "fe80::1"]);
    expect(card?.sourceIp).toBe("127.0.0.1");
  });

  it("leaves reportedIps null when the client reports none, still recording sourceIp (#355)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(201);
    const stored = harness.db.select().from(clients).all();
    expect(stored[0]?.reportedIps).toBeNull();
    expect(stored[0]?.sourceIp).toBe("127.0.0.1");
  });

  it("400s an enrol whose reportedIps carry a non-IP charset (#355)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
      reportedIps: ['1.2.3.4"; rm -rf'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("carries the token's friendly name onto the enrolled client and titles the card (#355)", async () => {
    const userId = await createUser("Alice");
    const mint = await admin({
      method: "POST",
      url: "/api/clients/enrolment-tokens",
      payload: {
        supervisedUsers: [{ userId, osUsername: "alice" }],
        friendlyName: "kids' living-room PC",
      },
    });
    expect(mint.statusCode).toBe(201);

    const res = await enrol(mint.json().token as string, {
      hostname: "omega-B85M-DS3H",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(201);

    const stored = harness.db.select().from(clients).all();
    expect(stored[0]?.friendlyName).toBe("kids' living-room PC");

    const card = await cardFor(res.json().clientId as number);
    expect(card?.friendlyName).toBe("kids' living-room PC");
    expect(card?.hostname).toBe("omega-B85M-DS3H");
  });

  it("leaves the client friendly name null when the token set none (#355)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(201);
    const stored = harness.db.select().from(clients).all();
    expect(stored[0]?.friendlyName).toBeNull();
  });

  it("lets the admin rename a client's friendly name after enrol (#355)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const res = await enrol(token, {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    const clientId = res.json().clientId as number;

    const patched = await admin({
      method: "PATCH",
      url: `/api/clients/${clientId}`,
      payload: { friendlyName: "study desktop" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().friendlyName).toBe("study desktop");
  });

  it("401s reuse of a consumed token (single-use)", async () => {
    const userId = await createUser("Alice");
    const token = await mintFor(userId, "alice");
    const payload = {
      hostname: "mint-01",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
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
      supervisedUsers: [{ osUsername: "bob", osUserRef: "1000" }],
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
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
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
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
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
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
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
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
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
        supervisedUsers: [{ userId, osUsername: "alice" }],
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
      payload: { supervisedUsers: [{ userId, osUsername: "alice" }] },
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
            { userId: aliceId, osUsername: "alice" },
            { userId: bobId, osUsername: "bob" },
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
          { osUsername: "alice", osUserRef: "1000" },
          { osUsername: "bob", osUserRef: "1001" },
        ],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().supervisedUsers).toEqual([
        { userId: aliceId, osUsername: "alice", osUserRef: "1000" },
        { userId: bobId, osUsername: "bob", osUserRef: "1001" },
      ]);
    });

    it("400s when a bound user is dropped from the enrol request", async () => {
      const [token] = await mintTwo();
      const res = await enrol(token, {
        hostname: "mint-01",
        sshUser: "pct-agent",
        supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
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
          { osUsername: "alice", osUserRef: "1000" },
          { osUsername: "carol", osUserRef: "1002" },
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
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("enrolment_token_expired");
  });

  // --- rate limiting (#154) ------------------------------------------------

  describe("rate limiting (#154)", () => {
    const validPayload = {
      hostname: "mint-rl",
      sshUser: "pct-agent",
      supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
    };

    it("429s once the failed-attempt budget is exhausted (missing-bearer failures)", async () => {
      const userId = await createUser("Alice");
      const token = await mintFor(userId, "alice");

      // Exhaust the budget with bearer-less attempts (each a 401).
      for (let i = 0; i < ENROL_RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
        const fail = await enrol(null, validPayload);
        expect(fail.statusCode).toBe(401);
        expect(fail.json().error.code).toBe("unauthorized");
      }

      // The next request is refused before processing — even with a valid token.
      const blocked = await enrol(token, validPayload);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("too_many_requests");
    });

    it("a successful enrol clears the IP's failure count", async () => {
      const userId = await createUser("Alice");
      const token = await mintFor(userId, "alice");

      // One short of the budget with invalid-token failures (service 401s).
      for (let i = 0; i < ENROL_RATE_LIMIT_MAX_ATTEMPTS - 1; i += 1) {
        expect((await enrol("not-a-real-token", validPayload)).statusCode).toBe(401);
      }

      // A success resets the window.
      expect((await enrol(token, validPayload)).statusCode).toBe(201);

      // Another near-budget run of failures still doesn't trip the limiter —
      // without the reset, the cumulative count would have blocked us by now.
      for (let i = 0; i < ENROL_RATE_LIMIT_MAX_ATTEMPTS - 1; i += 1) {
        const after = await enrol("not-a-real-token", validPayload);
        expect(after.statusCode).toBe(401);
      }
    });

    it("tracks the failed-attempt budget independently per source IP", async () => {
      const userId = await createUser("Alice");
      const token = await mintFor(userId, "alice");

      // Exhaust one IP's budget with bearer-less failures.
      for (let i = 0; i < ENROL_RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
        const fail = await harness.app.inject({
          method: "POST",
          url: "/api/clients/enrol",
          payload: validPayload,
          remoteAddress: "10.0.0.1",
        });
        expect(fail.statusCode).toBe(401);
      }

      // That IP is now blocked, even presenting a valid token...
      const blocked = await harness.app.inject({
        method: "POST",
        url: "/api/clients/enrol",
        payload: validPayload,
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: "10.0.0.1",
      });
      expect(blocked.statusCode).toBe(429);

      // ...but a different IP is unaffected and enrols normally.
      const other = await harness.app.inject({
        method: "POST",
        url: "/api/clients/enrol",
        payload: validPayload,
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: "10.0.0.2",
      });
      expect(other.statusCode).toBe(201);
    });

    it("valid-token rejections (400/409) don't count toward the budget", async () => {
      const userId = await createUser("Alice");
      // A 400 mismatch is thrown before the token is consumed, so one token
      // drives every mismatch attempt — none of which should accrue.
      const token = await mintFor(userId, "alice");
      const mismatch = {
        hostname: "mint-rl",
        sshUser: "pct-agent",
        supervisedUsers: [{ osUsername: "bob", osUserRef: "1000" }],
      };

      for (let i = 0; i < ENROL_RATE_LIMIT_MAX_ATTEMPTS + 2; i += 1) {
        const res = await enrol(token, mismatch);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("enrolment_user_mismatch");
      }

      // Despite more than a budget's worth of 400s, the same token still enrols:
      // the limiter never blocked, because valid-token rejections are neutral.
      const ok = await enrol(token, validPayload);
      expect(ok.statusCode).toBe(201);
    });
  });
});
