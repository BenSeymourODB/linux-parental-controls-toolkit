/**
 * HTTP tests for the post-enrol connectivity-verification route (#354):
 * `POST /api/clients/:id/verify-connection`, driven through the real app via
 * `app.inject()`. Covers the client-bearer auth (missing/invalid token), the
 * "only your own connection" ownership guard, the `503` when no verifier is
 * wired, the reachable / unreachable outcomes with the persisted side-effect,
 * and the per-client rate-limit budget — per docs/testing.md → "HTTP routes".
 *
 * A fake {@link ClientConnectionVerifier} is injected via a stub
 * {@link PolicyPushTransport} so the round-trip runs without SSH; a separate app
 * built without one exercises the `503` fallback.
 */
import { eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashToken } from "../../../src/auth/secret-token.js";
import { loadSettings } from "../../../src/config.js";
import * as repo from "../../../src/policy/repository.js";
import { clients } from "../../../src/policy/schema.js";
import type { PolicyPushTransport } from "../../../src/transport/policy-push/index.js";
import type {
  ClientConnectionVerifier,
  ConnectionVerification,
} from "../../../src/transport/health/index.js";
import { VERIFY_RATE_LIMIT_MAX_ATTEMPTS } from "../../../src/api/clients/index.js";
import { buildTestApp, type TestApp } from "../../helpers/app.js";

const TOKEN = "client-bearer-token-abc";
const AT = new Date("2026-08-23T10:00:00.000Z");

function configuredSettings() {
  return loadSettings({ PCT_LOG_LEVEL: "silent", PCT_SECRET_KEY: "verify-test-secret" });
}

/** A stub transport carrying only the verifier (dispatcher is inert). */
function transportWith(verifier?: ClientConnectionVerifier): PolicyPushTransport {
  return {
    dispatcher: { push: () => undefined },
    ...(verifier !== undefined ? { verifier } : {}),
    dispose: () => undefined,
  };
}

/** A recording fake verifier that returns a fixed outcome. */
function fakeVerifier(outcome: ConnectionVerification): {
  verifier: ClientConnectionVerifier;
  verify: ReturnType<typeof vi.fn>;
} {
  const verify = vi.fn(async () => outcome);
  return { verifier: { verify }, verify };
}

/** Seed a client and give it a per-client bearer token (hashed at rest). */
function seedEnrolledClient(app: TestApp, hostname = "alice-pc.local"): number {
  const id = repo.createClient(app.db, { hostname, sshUser: "pct-agent" }).id;
  app.db
    .update(clients)
    .set({ bearerTokenHash: hashToken(TOKEN) })
    .where(eq(clients.id, id))
    .run();
  return id;
}

describe("POST /api/clients/:id/verify-connection", () => {
  let harness: TestApp;

  afterEach(async () => {
    await harness.close();
  });

  async function start(transport: PolicyPushTransport): Promise<void> {
    harness = buildTestApp({
      appOptions: { settings: configuredSettings(), policyPush: transport },
    });
    await harness.app.ready();
  }

  function verify(id: number, token: string | null) {
    const opts: InjectOptions = {
      method: "POST",
      url: `/api/clients/${id}/verify-connection`,
    };
    if (token !== null) opts.headers = { authorization: `Bearer ${token}` };
    return harness.app.inject(opts);
  }

  it("rejects a request with no bearer token as 401", async () => {
    await start(
      transportWith(fakeVerifier({ reachable: true, reason: null, detail: "ok", at: AT }).verifier),
    );
    const id = seedEnrolledClient(harness);
    const res = await verify(id, null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects an unknown bearer token as 401", async () => {
    await start(
      transportWith(fakeVerifier({ reachable: true, reason: null, detail: "ok", at: AT }).verifier),
    );
    const id = seedEnrolledClient(harness);
    const res = await verify(id, "not-the-token");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects verifying another client's connection as 403", async () => {
    await start(
      transportWith(fakeVerifier({ reachable: true, reason: null, detail: "ok", at: AT }).verifier),
    );
    seedEnrolledClient(harness, "alice-pc.local"); // owns TOKEN
    const otherId = repo.createClient(harness.db, {
      hostname: "bob-pc.local",
      sshUser: "pct-agent",
    }).id;
    const res = await verify(otherId, TOKEN);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("returns 503 when no verifier is wired (pre-#39)", async () => {
    await start(transportWith(undefined));
    const id = seedEnrolledClient(harness);
    const res = await verify(id, TOKEN);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("verification_unavailable");
  });

  it("verifies a reachable client, persists the outcome, and bumps last_seen", async () => {
    const fake = fakeVerifier({
      reachable: true,
      reason: null,
      detail: "SSH round-trip succeeded",
      at: AT,
    });
    await start(transportWith(fake.verifier));
    const id = seedEnrolledClient(harness);

    const res = await verify(id, TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reachable: true,
      detail: "SSH round-trip succeeded",
      verifiedAt: AT.toISOString(),
    });
    expect(fake.verify).toHaveBeenCalledOnce();

    const row = repo.getClient(harness.db, id);
    expect(row?.lastVerifyReachable).toBe(true);
    expect(row?.lastVerifyReason).toBeNull();
    expect(row?.lastVerifiedAt).toEqual(AT);
    expect(row?.lastSeen).toEqual(AT);
  });

  it("verifies an unreachable client and surfaces + persists the failure class", async () => {
    const fake = fakeVerifier({
      reachable: false,
      reason: "dns",
      detail: "SSH verification failed (dns: getaddrinfo ENOTFOUND)",
      at: AT,
    });
    await start(transportWith(fake.verifier));
    const id = seedEnrolledClient(harness);

    const res = await verify(id, TOKEN);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(false);
    expect(body.failureClass).toBe("dns");
    expect(body.detail).toContain("dns");

    const row = repo.getClient(harness.db, id);
    expect(row?.lastVerifyReachable).toBe(false);
    expect(row?.lastVerifyReason).toBe("dns");
    // A failed verification is not a sighting.
    expect(row?.lastSeen).toBeNull();
  });

  it("budgets verification attempts per client (429 once the window is spent)", async () => {
    const fake = fakeVerifier({ reachable: true, reason: null, detail: "ok", at: AT });
    await start(transportWith(fake.verifier));
    const id = seedEnrolledClient(harness);

    for (let i = 0; i < VERIFY_RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
      const ok = await verify(id, TOKEN);
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await verify(id, TOKEN);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("too_many_requests");
  });
});
