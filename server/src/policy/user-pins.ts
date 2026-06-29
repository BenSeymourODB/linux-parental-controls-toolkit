/**
 * Policy-store data access for per-user PIN credentials (#112).
 *
 * Thin, synchronous functions over the shared {@link PolicyDb} for the
 * `user_pins` table — the credential behind the `/app` child-scoped session.
 * HTTP concerns (status codes, the error envelope) and PIN hashing live in the
 * `auth/`/`api/` layers; this module only touches the database and never sees a
 * plaintext PIN — callers pass an already-computed Argon2id hash.
 *
 * One PIN per user (`user_id` is the primary key); {@link setUserPin} upserts so
 * setting a PIN replaces any existing one. The row is removed with its user via
 * the `ON DELETE CASCADE` foreign key, so clearing a deleted user's PIN is never
 * needed.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT).
 */
import { eq, sql } from "drizzle-orm";

import type { PolicyDb } from "./db.js";
import { userPins } from "./schema.js";

/** A persisted {@link userPins} row. */
export type UserPinRow = typeof userPins.$inferSelect;

/**
 * Upsert a user's PIN to `hashedPin` and return the stored row. Replacing an
 * existing PIN bumps `updated_at` (and leaves `created_at` at the original set
 * time). The caller has already confirmed the user exists and Argon2id-hashed
 * the plaintext.
 */
export function setUserPin(db: PolicyDb, userId: number, hashedPin: string): UserPinRow {
  return db
    .insert(userPins)
    .values({ userId, hashedPin })
    .onConflictDoUpdate({
      target: userPins.userId,
      set: { hashedPin, updatedAt: sql`(unixepoch())` },
    })
    .returning()
    .get();
}

/** The Argon2id hash of a user's PIN, or `undefined` if the user has no PIN. */
export function getUserPinHash(db: PolicyDb, userId: number): string | undefined {
  return db
    .select({ hashedPin: userPins.hashedPin })
    .from(userPins)
    .where(eq(userPins.userId, userId))
    .get()?.hashedPin;
}

/** Whether the user currently has a PIN set. */
export function hasUserPin(db: PolicyDb, userId: number): boolean {
  return getUserPinHash(db, userId) !== undefined;
}

/** Clear a user's PIN. Returns whether a PIN row was removed. */
export function clearUserPin(db: PolicyDb, userId: number): boolean {
  return (
    db
      .delete(userPins)
      .where(eq(userPins.userId, userId))
      .returning({ userId: userPins.userId })
      .get() !== undefined
  );
}
