/**
 * Integration-token lifecycle + authentication service (#114).
 *
 * Sits between the HTTP layer (`api/integrations/routes.ts`, admin-guarded
 * management) / the guard (`integrations/guard.ts`, bearer auth) and the policy
 * store (`policy/integration-tokens.ts`). It mints high-entropy secrets, hashes
 * them at rest (reusing `auth/secret-token.ts`, exactly as that module's
 * docstring anticipates), and maps store-level outcomes onto {@link ApiError}s
 * in the shared envelope.
 *
 * License boundary: none touched — plain TypeScript + `node:crypto` (via
 * `auth/secret-token.ts`) + Drizzle.
 */
import { generateToken, hashToken } from "../auth/secret-token.js";
import { ApiError } from "../api/errors.js";
import type { PolicyDb } from "../policy/db.js";
import * as repo from "../policy/repository.js";
import * as tokenRepo from "../policy/integration-tokens.js";
import type { IntegrationTokenRow } from "../policy/integration-tokens.js";
import { INTEGRATION_SCOPES, type IntegrationScope } from "./scopes.js";

/** A newly issued token: the plaintext `secret` is returned **once**, here. */
export interface IssuedIntegrationToken {
  id: number;
  name: string;
  scopes: IntegrationScope[];
  /** The plaintext bearer secret — shown once; only its hash is persisted. */
  secret: string;
  createdAt: Date;
}

/** A token as the admin sees it — never carries the secret or its hash. */
export interface IntegrationTokenSummary {
  id: number;
  name: string;
  scopes: IntegrationScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** The identity a presented bearer token resolves to, for the guard. */
export interface AuthenticatedIntegration {
  id: number;
  name: string;
  scopes: IntegrationScope[];
}

/** The set of currently-known scopes, for narrowing stored values. */
const KNOWN_SCOPES = new Set<string>(INTEGRATION_SCOPES);

/**
 * Narrow a stored `string[]` to `IntegrationScope[]`, dropping any value no
 * longer in the vocabulary. All writes go through the validated DTO, so this is
 * defensive (a scope removed in a later version never crashes a read) rather
 * than load-bearing — and it avoids an unchecked `as` cast on stored data.
 */
function toIntegrationScopes(raw: string[]): IntegrationScope[] {
  return raw.filter((s): s is IntegrationScope => KNOWN_SCOPES.has(s));
}

/** Map a stored row to the admin-facing summary (no secret material). */
function toSummary(row: IntegrationTokenRow): IntegrationTokenSummary {
  return {
    id: row.id,
    name: row.name,
    scopes: toIntegrationScopes(row.scopes),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Mint a new integration token. The plaintext secret is generated, hashed, and
 * persisted with the requested scopes; the plaintext is returned once and never
 * stored. A duplicate `name` is a 409.
 */
export function issueIntegrationToken(
  db: PolicyDb,
  input: { name: string; scopes: IntegrationScope[] },
): IssuedIntegrationToken {
  const secret = generateToken();
  let row: IntegrationTokenRow;
  try {
    row = tokenRepo.createIntegrationToken(db, {
      name: input.name,
      scopes: input.scopes,
      hashedSecret: hashToken(secret),
    });
  } catch (err) {
    if (repo.isUniqueViolation(err)) {
      throw new ApiError(
        409,
        "conflict",
        `An integration token named "${input.name}" already exists`,
      );
    }
    throw err;
  }
  return { id: row.id, name: row.name, scopes: input.scopes, secret, createdAt: row.createdAt };
}

/** All integration tokens, oldest first, as admin-facing summaries. */
export function listIntegrationTokenSummaries(db: PolicyDb): IntegrationTokenSummary[] {
  return tokenRepo.listIntegrationTokens(db).map(toSummary);
}

/**
 * Revoke a token by id and return its (now-revoked) summary. A missing id is a
 * 404; revoking an already-revoked token is a no-op that returns the existing
 * summary (idempotent).
 */
export function revokeIntegrationToken(db: PolicyDb, id: number): IntegrationTokenSummary {
  const row = tokenRepo.revokeIntegrationToken(db, id);
  if (row === undefined) {
    throw new ApiError(404, "not_found", `Integration token ${id} not found`);
  }
  return toSummary(row);
}

/**
 * Resolve a presented plaintext bearer secret to its integration identity for
 * the guard. An unknown or revoked secret is a 401 — the same code for both so a
 * caller can't distinguish "wrong token" from "revoked token". On success the
 * token's `last_used_at` is touched and its scopes are returned.
 *
 * `last_used_at` records the **last successful authentication**, not the last
 * *authorized* request: a token that authenticates here but is then rejected
 * `403` by the guard for a missing scope still has its `last_used_at` bumped,
 * because the credential was validly presented. That is the semantics the admin
 * audit view should describe.
 */
export function authenticateIntegrationToken(
  db: PolicyDb,
  secret: string,
): AuthenticatedIntegration {
  const row = tokenRepo.findIntegrationTokenByHash(db, hashToken(secret));
  if (row === undefined || row.revokedAt !== null) {
    throw new ApiError(401, "unauthorized", "Invalid or revoked integration token");
  }
  tokenRepo.touchIntegrationTokenLastUsed(db, row.id);
  return { id: row.id, name: row.name, scopes: toIntegrationScopes(row.scopes) };
}
