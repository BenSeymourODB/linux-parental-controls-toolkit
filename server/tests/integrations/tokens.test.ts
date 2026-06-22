/**
 * Unit tests for the integration-token lifecycle + authentication service
 * (#114), against a fresh in-memory policy DB.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "../../src/api/errors.js";
import { hashToken } from "../../src/auth/secret-token.js";
import {
  authenticateIntegrationToken,
  issueIntegrationToken,
  listIntegrationTokenSummaries,
  revokeIntegrationToken,
} from "../../src/integrations/tokens.js";
import { findIntegrationTokenByHash } from "../../src/policy/integration-tokens.js";
import { testDb } from "../helpers/db.js";

describe("integration-token service", () => {
  it("issues a token, returning the plaintext once and storing only its hash", () => {
    const db = testDb();
    const issued = issueIntegrationToken(db, { name: "calendar", scopes: ["grants:write"] });

    expect(issued.secret).toMatch(/.+/);
    expect(issued.scopes).toEqual(["grants:write"]);
    // The stored row holds the hash of the plaintext, never the plaintext.
    expect(findIntegrationTokenByHash(db, hashToken(issued.secret))?.id).toBe(issued.id);
    expect(findIntegrationTokenByHash(db, issued.secret)).toBeUndefined();
    db.$client.close();
  });

  it("rejects a duplicate name with a 409", () => {
    const db = testDb();
    issueIntegrationToken(db, { name: "calendar", scopes: ["grants:write"] });
    try {
      issueIntegrationToken(db, { name: "calendar", scopes: ["policy:read"] });
      expect.unreachable("expected a 409");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(409);
    }
    db.$client.close();
  });

  it("lists summaries without any secret material", () => {
    const db = testDb();
    issueIntegrationToken(db, { name: "calendar", scopes: ["grants:write", "policy:read"] });
    const [summary] = listIntegrationTokenSummaries(db);

    expect(summary).toBeDefined();
    expect(summary?.name).toBe("calendar");
    expect(summary?.scopes).toEqual(["grants:write", "policy:read"]);
    expect(summary?.revokedAt).toBeNull();
    // No `secret` / `hashedSecret` field is exposed on a summary.
    expect(summary && "secret" in summary).toBe(false);
    expect(summary && "hashedSecret" in summary).toBe(false);
    db.$client.close();
  });

  it("authenticates a valid token, touching last_used_at", () => {
    const db = testDb();
    const issued = issueIntegrationToken(db, { name: "calendar", scopes: ["grants:write"] });

    const identity = authenticateIntegrationToken(db, issued.secret);
    expect(identity).toEqual({ id: issued.id, name: "calendar", scopes: ["grants:write"] });
    expect(findIntegrationTokenByHash(db, hashToken(issued.secret))?.lastUsedAt).toBeInstanceOf(
      Date,
    );
    db.$client.close();
  });

  it("rejects an unknown secret with a 401", () => {
    const db = testDb();
    try {
      authenticateIntegrationToken(db, "not-a-real-token");
      expect.unreachable("expected a 401");
    } catch (err) {
      expect((err as ApiError).statusCode).toBe(401);
    }
    db.$client.close();
  });

  it("rejects a revoked token with a 401", () => {
    const db = testDb();
    const issued = issueIntegrationToken(db, { name: "calendar", scopes: ["grants:write"] });
    revokeIntegrationToken(db, issued.id);

    try {
      authenticateIntegrationToken(db, issued.secret);
      expect.unreachable("expected a 401");
    } catch (err) {
      expect((err as ApiError).statusCode).toBe(401);
    }
    db.$client.close();
  });

  it("revokes by id and is idempotent; 404 for an unknown id", () => {
    const db = testDb();
    const issued = issueIntegrationToken(db, { name: "calendar", scopes: ["grants:write"] });

    const revoked = revokeIntegrationToken(db, issued.id);
    expect(revoked.revokedAt).not.toBeNull();
    // Idempotent: revoking again still returns a revoked summary.
    expect(revokeIntegrationToken(db, issued.id).revokedAt).not.toBeNull();

    try {
      revokeIntegrationToken(db, 99999);
      expect.unreachable("expected a 404");
    } catch (err) {
      expect((err as ApiError).statusCode).toBe(404);
    }
    db.$client.close();
  });
});
