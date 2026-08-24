/**
 * Policy-store data access for the immutable grant ledger (#113).
 *
 * Companion to {@link ./integration-tokens.ts}: thin, synchronous functions
 * over the shared {@link PolicyDb} for the `grants` table. HTTP concerns (status
 * codes, the error envelope, `user_ref` resolution, `source` stamping) live in
 * the `api/integrations/` route layer; this module only touches the database.
 *
 * The ledger is **append-plus-revoke only** (`policy/schema.ts`): business
 * columns are never UPDATEd in place, and idempotency is structural — a
 * `UNIQUE(source_ref)` index means a retried integrator webhook cannot
 * double-grant. This module exposes exactly the two operations the grant
 * endpoint needs — create, and look up by `source_ref` for the idempotent
 * replay — and never an update of a grant's business columns.
 *
 * License boundary: none touched — Drizzle (Apache-2.0) + better-sqlite3 (MIT).
 */
import { eq } from "drizzle-orm";

import type { PolicyDb } from "./db.js";
import type { Scope } from "./enums.js";
import { grants } from "./schema.js";

/** A persisted {@link grants} row. */
export type GrantRow = typeof grants.$inferSelect;

/**
 * Fields accepted when creating a {@link grants} row. Validated by the route's
 * DTO + coherence checks before this call; the table's CHECK constraints
 * (`seconds_granted > 0`, scope/target coherence, `source` shape) backstop it.
 */
export interface GrantCreate {
  /** The subject user (already resolved from the wire `user_ref`). */
  userId: number;
  /** Grant scope; mirrors policy scopes (`overall` | `activity` | `group`). */
  scope: Scope;
  /**
   * `activities.id` for `activity`, `activity_groups.id` for `group`, `null`
   * for `overall` (the schema's coherence CHECK enforces the null-ness).
   */
  targetId: number | null;
  /** Seconds granted; must be > 0 (table CHECK). */
  secondsGranted: number;
  /** Exclusive end of the grant's life. */
  expiresAt: Date;
  /** Provenance: `admin` or `integration:<name>` (table CHECK). */
  source: string;
  /**
   * The integrator-owned idempotency key; `UNIQUE` across the table so a
   * retried request cannot double-grant. `null` for admin-issued grants.
   */
  sourceRef: string | null;
  /** Optional free-text reason for the audit trail / ledger UI (#116). */
  reason: string | null;
}

/**
 * Insert a grant and return the stored row. `source_ref` is unique; a duplicate
 * raises a SQLite unique violation the caller maps to an idempotent replay via
 * {@link import("./repository.js").isUniqueViolation} + {@link findGrantBySourceRef}.
 * The table's CHECK constraints (seconds, target coherence, source shape) raise
 * a check violation the caller maps to a 400 via
 * {@link import("./repository.js").isCheckViolation}.
 *
 * `granted_at` defaults to now (schema `timestampNow`); `revoked_at` stays NULL
 * — revocation is a separate write, never part of creation.
 */
export function createGrant(db: PolicyDb, input: GrantCreate): GrantRow {
  return db
    .insert(grants)
    .values({
      userId: input.userId,
      scope: input.scope,
      targetId: input.targetId,
      secondsGranted: input.secondsGranted,
      expiresAt: input.expiresAt,
      source: input.source,
      sourceRef: input.sourceRef,
      reason: input.reason,
    })
    .returning()
    .get();
}

/**
 * Look up a grant by its `source_ref`, or `undefined` if none exists. Used for
 * the idempotent replay: a second request carrying a `source_ref` already in
 * the ledger returns the stored row rather than creating a new one. Passing a
 * `null`/absent `source_ref` is never valid here — admin grants (which have no
 * `source_ref`) do not go through this path — so the caller only calls this with
 * a concrete key.
 */
export function findGrantBySourceRef(db: PolicyDb, sourceRef: string): GrantRow | undefined {
  return db.select().from(grants).where(eq(grants.sourceRef, sourceRef)).get();
}
