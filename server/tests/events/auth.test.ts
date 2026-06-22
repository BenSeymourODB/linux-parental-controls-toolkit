/**
 * Unit tests for event-stream bearer auth (#100) against a hermetic in-memory
 * DB: a valid per-client token resolves to its client, and a missing,
 * malformed, or unknown token is a 401 (with the same opaque code).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../../src/api/errors.js";
import { generateToken, hashToken } from "../../src/auth/secret-token.js";
import { authenticateEventClient } from "../../src/events/auth.js";
import { clients } from "../../src/policy/schema.js";
import { testDb, type TestDb } from "../helpers/db.js";

/** Insert a client carrying the hash of `token`; return its id. */
function enrolClientWithToken(db: TestDb, token: string, hostname = "mint-01"): number {
  return db
    .insert(clients)
    .values({ hostname, sshUser: "pct-agent", bearerTokenHash: hashToken(token) })
    .returning()
    .get().id;
}

describe("authenticateEventClient", () => {
  let db: TestDb;
  beforeEach(() => {
    db = testDb();
  });
  afterEach(() => {
    db.$client.close();
  });

  it("resolves a valid bearer token to its enrolled client", () => {
    const token = generateToken();
    const id = enrolClientWithToken(db, token);
    const client = authenticateEventClient(db, `Bearer ${token}`);
    expect(client.id).toBe(id);
    expect(client.hostname).toBe("mint-01");
  });

  it("rejects a missing or malformed Authorization header with 401", () => {
    for (const header of [undefined, "", "Token abc", "Bearer ", "bearer x"]) {
      const err = (() => {
        try {
          authenticateEventClient(db, header);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(401);
    }
  });

  it("rejects an unknown token with 401", () => {
    enrolClientWithToken(db, generateToken());
    expect(() => authenticateEventClient(db, `Bearer ${generateToken()}`)).toThrowError(ApiError);
    try {
      authenticateEventClient(db, `Bearer ${generateToken()}`);
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(401);
    }
  });
});
