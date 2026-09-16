/**
 * Per-entity retention purge coverage (#138, epic #135).
 *
 * The retention *rule* lives in `retention.ts` (`RetentionPolicy` — #136); this
 * module is the *mechanism* that enforces it: one bounded, idempotent deletion
 * routine per retention category. The scheduled job (#137) drives these
 * routines and audits their {@link PurgeCategoryResult} summaries; nothing here
 * decides *when* to run — only *what* is purgeable and *how* to delete it
 * safely.
 *
 * ## What each category keys its age on
 *
 * - **`usage_samples`** → `ended_at`. A sample covers `[started_at, ended_at)`;
 *   keying on the later bound purges it only once its whole interval is older
 *   than the window, so no in-window burndown/rollup still needs it.
 * - **`date_overrides`** → the *end* of the override's active window
 *   (`exceptions`/`group_exceptions`.`expires_at`,
 *   `schedules`/`group_schedules`.`effective_to`). A rule is purged only when it
 *   is wholly in the past, so an active or future-dated override is never
 *   removed. Schedules with a **null** `effective_to` are open-ended recurring
 *   rules (ADR 0005 §4) and are never matched — retention targets *dated* data,
 *   not recurrence rules.
 * - **`audit_log`** → `at`. No dependents (its FKs are `on delete set null`).
 * - **`grant_ledger`** → `expires_at`. In this schema a revocation is a
 *   `revoked_at` **column on the same row**, not a separate ledger row
 *   (`schema.ts`), so purging a grant cannot orphan a revocation from its grant.
 *   Keying on `expires_at` purges a grant only after it has expired (inactive),
 *   so an active grant is never purged regardless of its ledger age.
 *
 * ## Cutoff, not row-by-row
 *
 * `RetentionPolicy.isExpired` is monotonic in the record timestamp, so each
 * category resolves to a single cutoff instant (`cutoffFor`) and the purge is a
 * set-based `DELETE WHERE <ts> < cutoff` (strict `<`, matching the rule).
 * `keepForever` ⇒ `cutoff === null` ⇒ nothing is purged. (Timestamp columns
 * are stored as whole epoch seconds, so the SQL comparison is second-granular
 * — irrelevant at a days-scale retention window.)
 *
 * ## Bounded / interruptible batching
 *
 * `better-sqlite3`'s bundled SQLite is not built with
 * `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, so `DELETE … LIMIT` is unavailable.
 * Instead each pass deletes the rows whose primary key is in a `LIMIT
 * batchSize` sub-select of the matching set, looping until a pass deletes fewer
 * than a full batch. Each pass is its own implicit transaction (no long-held
 * write lock), so a large first run never locks the store and an interrupted
 * run resumes on the next tick — the cutoff predicate is stable, so a re-run
 * only ever finds the not-yet-deleted remainder.
 *
 * License boundary: none touched — pure TypeScript + Drizzle over the policy
 * store; no GPL linkage, no subprocess/REST boundary, no image change.
 */
import { and, count, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type { PolicyDb } from "./db.js";
import type { RetentionCategory } from "./enums.js";
import type { RetentionPolicy } from "./retention.js";
import {
  auditLog,
  exceptions,
  grants,
  groupExceptions,
  groupSchedules,
  schedules,
  usageSamples,
} from "./schema.js";

/**
 * Default id-batch size per delete pass. Comfortably under SQLite's bound
 * parameter limit while still amortising the per-batch round trip on a large
 * first run.
 */
export const DEFAULT_PURGE_BATCH_SIZE = 1000;

/** The outcome of purging one retention category. */
export interface PurgeCategoryResult {
  /** The category purged. */
  readonly category: RetentionCategory;
  /**
   * The cutoff instant applied — records strictly older than this were
   * deleted. `null` when the category is kept forever (nothing purged).
   */
  readonly cutoff: Date | null;
  /** How many rows were deleted across every table in the category. */
  readonly deleted: number;
}

/** Tunables shared by every purge routine. */
export interface PurgeOptions {
  /** Rows deleted per pass (default {@link DEFAULT_PURGE_BATCH_SIZE}). */
  readonly batchSize?: number;
}

/**
 * Run `deleteOneBatch` until a pass deletes fewer than `batchSize` rows (the
 * last page) — or none at all. Returns the total deleted. The loop terminates
 * because every pass removes the rows it selected, shrinking the matching set,
 * and is safe to resume after an interruption for the same reason.
 */
function purgeInBatches(deleteOneBatch: () => number, batchSize: number): number {
  // A non-positive batch size can never make progress (`LIMIT 0` deletes
  // nothing; SQLite treats `LIMIT -1` as unlimited), so the `n < batchSize`
  // break would never trip — reject it loudly rather than spin forever once
  // #137 starts driving this with configurable values.
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`purge batch size must be a positive integer, got ${batchSize}`);
  }
  let deleted = 0;
  for (;;) {
    const n = deleteOneBatch();
    deleted += n;
    if (n < batchSize) {
      break;
    }
  }
  return deleted;
}

/** Resolve the batch size, defaulting when unset. */
function batchSizeOf(opts: PurgeOptions | undefined): number {
  return opts?.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;
}

/**
 * Purge `usage_samples` rows whose interval ended before the category cutoff.
 */
export function purgeUsageSamples(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
  opts?: PurgeOptions,
): PurgeCategoryResult {
  const cutoff = policy.cutoffFor("usage_samples", now);
  if (cutoff === null) {
    return { category: "usage_samples", cutoff, deleted: 0 };
  }
  const batchSize = batchSizeOf(opts);
  const deleted = purgeInBatches(
    () =>
      db
        .delete(usageSamples)
        .where(
          inArray(
            usageSamples.id,
            db
              .select({ id: usageSamples.id })
              .from(usageSamples)
              .where(lt(usageSamples.endedAt, cutoff))
              .limit(batchSize),
          ),
        )
        .run().changes,
    batchSize,
  );
  return { category: "usage_samples", cutoff, deleted };
}

/**
 * Purge date-scoped policy overrides wholly in the past: `exceptions` /
 * `group_exceptions` past `expires_at`, and date-scoped `schedules` /
 * `group_schedules` past `effective_to`. Open-ended recurrence rules (null
 * `effective_to`) are never touched.
 */
export function purgeDateOverrides(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
  opts?: PurgeOptions,
): PurgeCategoryResult {
  const cutoff = policy.cutoffFor("date_overrides", now);
  if (cutoff === null) {
    return { category: "date_overrides", cutoff, deleted: 0 };
  }
  const batchSize = batchSizeOf(opts);
  const deleted =
    purgeInBatches(
      () =>
        db
          .delete(exceptions)
          .where(
            inArray(
              exceptions.id,
              db
                .select({ id: exceptions.id })
                .from(exceptions)
                .where(lt(exceptions.expiresAt, cutoff))
                .limit(batchSize),
            ),
          )
          .run().changes,
      batchSize,
    ) +
    purgeInBatches(
      () =>
        db
          .delete(groupExceptions)
          .where(
            inArray(
              groupExceptions.id,
              db
                .select({ id: groupExceptions.id })
                .from(groupExceptions)
                .where(lt(groupExceptions.expiresAt, cutoff))
                .limit(batchSize),
            ),
          )
          .run().changes,
      batchSize,
    ) +
    purgeInBatches(
      () =>
        db
          .delete(schedules)
          .where(
            inArray(
              schedules.id,
              db
                .select({ id: schedules.id })
                .from(schedules)
                .where(and(isNotNull(schedules.effectiveTo), lt(schedules.effectiveTo, cutoff)))
                .limit(batchSize),
            ),
          )
          .run().changes,
      batchSize,
    ) +
    purgeInBatches(
      () =>
        db
          .delete(groupSchedules)
          .where(
            inArray(
              groupSchedules.id,
              db
                .select({ id: groupSchedules.id })
                .from(groupSchedules)
                .where(
                  and(
                    isNotNull(groupSchedules.effectiveTo),
                    lt(groupSchedules.effectiveTo, cutoff),
                  ),
                )
                .limit(batchSize),
            ),
          )
          .run().changes,
      batchSize,
    );
  return { category: "date_overrides", cutoff, deleted };
}

/** Purge `audit_log` entries recorded before the category cutoff. */
export function purgeAuditLog(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
  opts?: PurgeOptions,
): PurgeCategoryResult {
  const cutoff = policy.cutoffFor("audit_log", now);
  if (cutoff === null) {
    return { category: "audit_log", cutoff, deleted: 0 };
  }
  const batchSize = batchSizeOf(opts);
  const deleted = purgeInBatches(
    () =>
      db
        .delete(auditLog)
        .where(
          inArray(
            auditLog.id,
            db
              .select({ id: auditLog.id })
              .from(auditLog)
              .where(lt(auditLog.at, cutoff))
              .limit(batchSize),
          ),
        )
        .run().changes,
    batchSize,
  );
  return { category: "audit_log", cutoff, deleted };
}

/**
 * Purge expired `grants` (those past `expires_at`). Keying on `expires_at`
 * guarantees an active grant is never purged, and — since a revocation is a
 * column on the grant row, not a separate ledger row — purging can never orphan
 * a revocation from its grant.
 */
export function purgeGrants(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
  opts?: PurgeOptions,
): PurgeCategoryResult {
  const cutoff = policy.cutoffFor("grant_ledger", now);
  if (cutoff === null) {
    return { category: "grant_ledger", cutoff, deleted: 0 };
  }
  const batchSize = batchSizeOf(opts);
  const deleted = purgeInBatches(
    () =>
      db
        .delete(grants)
        .where(
          inArray(
            grants.id,
            db
              .select({ id: grants.id })
              .from(grants)
              .where(lt(grants.expiresAt, cutoff))
              .limit(batchSize),
          ),
        )
        .run().changes,
    batchSize,
  );
  return { category: "grant_ledger", cutoff, deleted };
}

/**
 * Run every category's purge in {@link RetentionCategory} declaration order and
 * return one {@link PurgeCategoryResult} per category — the per-run shape the
 * scheduled job (#137) records in the audit log. Categories are independent;
 * each runs in its own bounded passes so one large category never blocks the
 * others.
 */
export function purgeExpiredRecords(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
  opts?: PurgeOptions,
): PurgeCategoryResult[] {
  return [
    purgeUsageSamples(db, policy, now, opts),
    purgeGrants(db, policy, now, opts),
    purgeAuditLog(db, policy, now, opts),
    purgeDateOverrides(db, policy, now, opts),
  ];
}

// --- Dry-run counting (#137) -----------------------------------------------
//
// The read-only counterpart to the purge routines above: how many rows *would*
// be purged, without deleting anything. The scheduled job's preview mode and
// the `POST /api/retention/purge/preview` endpoint use it for operator
// confidence before a real run. Each count reuses the exact same per-category
// cutoff (`RetentionPolicy.cutoffFor`) and predicate (`<ts> < cutoff`) as the
// matching purge routine, so a preview and the run it precedes agree by
// construction (`keepForever` ⇒ cutoff `null` ⇒ nothing counted).

/** What a dry-run reports for one retention category. */
export interface CountCategoryResult {
  /** The category counted. */
  readonly category: RetentionCategory;
  /**
   * The cutoff instant that would be applied — records strictly older than
   * this would be deleted. `null` when the category is kept forever.
   */
  readonly cutoff: Date | null;
  /** How many rows a purge would delete across every table in the category. */
  readonly wouldDelete: number;
}

/**
 * `COUNT(*)` of rows in `table` matching `where` (each category's cutoff
 * predicate). `where` is `SQL | undefined` because `and(...)` narrows to
 * `undefined` when every operand is — never the case here, but it keeps the
 * call sites cast-free, and a `undefined` predicate would count every row
 * (harmless: it is never passed).
 */
function countOlderThan(db: PolicyDb, table: SQLiteTable, where: SQL | undefined): number {
  return db.select({ value: count() }).from(table).where(where).get()?.value ?? 0;
}

/** Count `usage_samples` rows whose interval ended before the category cutoff. */
export function countUsageSamples(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
): CountCategoryResult {
  const cutoff = policy.cutoffFor("usage_samples", now);
  if (cutoff === null) {
    return { category: "usage_samples", cutoff, wouldDelete: 0 };
  }
  return {
    category: "usage_samples",
    cutoff,
    wouldDelete: countOlderThan(db, usageSamples, lt(usageSamples.endedAt, cutoff)),
  };
}

/** Count expired `grants` (those past `expires_at`). */
export function countGrants(db: PolicyDb, policy: RetentionPolicy, now: Date): CountCategoryResult {
  const cutoff = policy.cutoffFor("grant_ledger", now);
  if (cutoff === null) {
    return { category: "grant_ledger", cutoff, wouldDelete: 0 };
  }
  return {
    category: "grant_ledger",
    cutoff,
    wouldDelete: countOlderThan(db, grants, lt(grants.expiresAt, cutoff)),
  };
}

/** Count `audit_log` entries recorded before the category cutoff. */
export function countAuditLog(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
): CountCategoryResult {
  const cutoff = policy.cutoffFor("audit_log", now);
  if (cutoff === null) {
    return { category: "audit_log", cutoff, wouldDelete: 0 };
  }
  return {
    category: "audit_log",
    cutoff,
    wouldDelete: countOlderThan(db, auditLog, lt(auditLog.at, cutoff)),
  };
}

/** Count date-scoped overrides wholly in the past (the four-table sum). */
export function countDateOverrides(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
): CountCategoryResult {
  const cutoff = policy.cutoffFor("date_overrides", now);
  if (cutoff === null) {
    return { category: "date_overrides", cutoff, wouldDelete: 0 };
  }
  const wouldDelete =
    countOlderThan(db, exceptions, lt(exceptions.expiresAt, cutoff)) +
    countOlderThan(db, groupExceptions, lt(groupExceptions.expiresAt, cutoff)) +
    countOlderThan(
      db,
      schedules,
      and(isNotNull(schedules.effectiveTo), lt(schedules.effectiveTo, cutoff)),
    ) +
    countOlderThan(
      db,
      groupSchedules,
      and(isNotNull(groupSchedules.effectiveTo), lt(groupSchedules.effectiveTo, cutoff)),
    );
  return { category: "date_overrides", cutoff, wouldDelete };
}

/**
 * Count what {@link purgeExpiredRecords} would delete, per category, in the same
 * {@link RetentionCategory} declaration order — the dry-run counterpart of the
 * purge, with no writes.
 */
export function countExpiredRecords(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
): CountCategoryResult[] {
  return [
    countUsageSamples(db, policy, now),
    countGrants(db, policy, now),
    countAuditLog(db, policy, now),
    countDateOverrides(db, policy, now),
  ];
}
