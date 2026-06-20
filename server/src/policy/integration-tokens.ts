/**
 * Policy-store data access for integration tokens (#114).
 *
 * Companion to {@link ./enrolment.ts}: thin, synchronous functions over the
 * shared {@link PolicyDb} for the `integration_tokens` table. HTTP concerns
 * (status codes, the error envelope) and token hashing live in the
 * `integrations/` service layer (`integrations/tokens.ts`); this module only
 * touches the database.
 *
 * Like enrolment tokens, only the SHA-256 hash of the bearer secret is stored —
 * never the plaintext (`docs/architecture.md` → "External integrations"). A
 * revoked token is kept (its `revoked_at` set), not deleted, so the admin can
 * still see and audit it.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT).
 */
import { and, eq, isNull } from "drizzle-orm";

import type { IntegrationScope } from "../integrations/scopes.js";
import type { PolicyDb } from "./db.js";
import { integrationTokens } from "./schema.js";

/** A persisted {@link integrationTokens} row. */
export type IntegrationTokenRow = typeof integrationTokens.$inferSelect;

/** Fields accepted when creating an {@link integrationTokens} row. */
export interface IntegrationTokenCreate {
  /** A unique, human-meaningful name for the integration (e.g. `calendar`). */
  name: string;
  /** The scopes this token carries; validated against the DTO before this call. */
  scopes: IntegrationScope[];
  /** SHA-256 of the plaintext bearer secret (never the plaintext itself). */
  hashedSecret: string;
}

/**
 * Insert an integration token and return the stored row. The `name` column is
 * unique; a duplicate raises a SQLite unique violation the caller maps to a 409
 * via {@link import("./repository.js").isUniqueViolation}.
 */
export function createIntegrationToken(
  db: PolicyDb,
  input: IntegrationTokenCreate,
): IntegrationTokenRow {
  return db
    .insert(integrationTokens)
    .values({
      name: input.name,
      scopes: input.scopes,
      hashedSecret: input.hashedSecret,
    })
    .returning()
    .get();
}

/** All integration tokens, oldest first. */
export function listIntegrationTokens(db: PolicyDb): IntegrationTokenRow[] {
  return db.select().from(integrationTokens).orderBy(integrationTokens.id).all();
}

/** Look up a single token by id, or `undefined` if none. */
export function getIntegrationToken(db: PolicyDb, id: number): IntegrationTokenRow | undefined {
  return db.select().from(integrationTokens).where(eq(integrationTokens.id, id)).get();
}

/** Look up a token by its SHA-256 secret hash, or `undefined` if none. */
export function findIntegrationTokenByHash(
  db: PolicyDb,
  hashedSecret: string,
): IntegrationTokenRow | undefined {
  return db
    .select()
    .from(integrationTokens)
    .where(eq(integrationTokens.hashedSecret, hashedSecret))
    .get();
}

/**
 * Revoke a token: set `revoked_at` iff it is currently NULL, and return the
 * resulting row. Returns `undefined` if no token has that id. Already-revoked
 * tokens are left untouched (the original `revoked_at` is preserved), so revoke
 * is idempotent.
 */
export function revokeIntegrationToken(db: PolicyDb, id: number): IntegrationTokenRow | undefined {
  db.update(integrationTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(integrationTokens.id, id), isNull(integrationTokens.revokedAt)))
    .run();
  return getIntegrationToken(db, id);
}

/**
 * Record that a token was just used for authentication (sets `last_used_at`).
 * Best-effort observability for the admin; not on the security path.
 */
export function touchIntegrationTokenLastUsed(db: PolicyDb, id: number): void {
  db.update(integrationTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(integrationTokens.id, id))
    .run();
}
