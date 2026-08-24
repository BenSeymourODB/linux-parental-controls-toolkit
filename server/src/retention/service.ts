/**
 * Retention purge service (#137, epic #135).
 *
 * The orchestration layer between the retention *rule* (`policy/retention.ts`,
 * #136), the per-entity purge *mechanism* (`policy/purge.ts`, #138), and the
 * run *ledger* (`retention_purge_runs`). Two operations:
 *
 * - {@link runRetentionPurge} — actually purge expired records and record the
 *   run so it is observable (the "audit every run" requirement). Driven by the
 *   croner scheduler (`scheduler.ts`) and by the admin "run now" endpoint.
 * - {@link previewRetentionPurge} — a side-effect-free dry run: count what
 *   *would* be purged, recording nothing (a preview is a read, not a run).
 *
 * `now` is injected (never read from the clock here) so the caller controls the
 * cutoff instant and tests are deterministic. The effective {@link
 * RetentionPolicy} is likewise passed in — the scheduler rebuilds it from the
 * env default + persisted overrides each pass, so a window change takes effect
 * on the next tick without a restart.
 *
 * License boundary: none touched — pure TypeScript + Drizzle over the policy
 * store; no GPL linkage, no subprocess/REST boundary, no image change.
 */
import { performance } from "node:perf_hooks";

import type { RetentionPurgeTrigger } from "../policy/enums.js";
import {
  countExpiredRecords,
  purgeExpiredRecords,
  type CountCategoryResult,
  type PurgeCategoryResult,
} from "../policy/purge.js";
import { recordPurgeRun, type RetentionPurgeRunRow } from "../policy/repository.js";
import type { RetentionPolicy } from "../policy/retention.js";
import type { PolicyDb } from "../policy/db.js";
import type { RetentionPurgeRunItem } from "../policy/schema.js";

/** Options for {@link runRetentionPurge}. */
export interface RunRetentionPurgeOptions {
  /** What triggered this run — recorded on the ledger row. */
  readonly trigger: RetentionPurgeTrigger;
  /** Rows deleted per pass; defaults to `DEFAULT_PURGE_BATCH_SIZE` in `purge.ts`. */
  readonly batchSize?: number;
}

/** A cutoff `Date` as the whole epoch seconds the ledger stores, or `null`. */
function cutoffToEpochSeconds(cutoff: Date | null): number | null {
  return cutoff === null ? null : Math.floor(cutoff.getTime() / 1000);
}

/** Map a purge result to the JSON ledger item shape (cutoff → epoch seconds). */
function toRunItem(result: PurgeCategoryResult): RetentionPurgeRunItem {
  return {
    category: result.category,
    cutoff: cutoffToEpochSeconds(result.cutoff),
    deleted: result.deleted,
  };
}

/**
 * Purge every expired record under `policy` as of `now`, record the run in the
 * ledger, and return the stored row. The purge itself is bounded/idempotent
 * (`policy/purge.ts`); this wrapper times it, sums the per-category deletions,
 * and appends one ledger entry so the run is observable.
 */
export function runRetentionPurge(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
  options: RunRetentionPurgeOptions,
): RetentionPurgeRunRow {
  const startedAt = performance.now();
  const results = purgeExpiredRecords(
    db,
    policy,
    now,
    options.batchSize !== undefined ? { batchSize: options.batchSize } : undefined,
  );
  const durationMs = Math.round(performance.now() - startedAt);
  const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
  return recordPurgeRun(db, {
    at: now,
    trigger: options.trigger,
    totalDeleted,
    durationMs,
    items: results.map(toRunItem),
  });
}

/** One category's dry-run projection: what a purge would remove, and the cutoff. */
export interface RetentionPurgePreviewItem {
  readonly category: CountCategoryResult["category"];
  /** The cutoff that would apply, or `null` when the category is kept forever. */
  readonly cutoff: Date | null;
  /** How many rows a purge would delete in this category. */
  readonly wouldDelete: number;
}

/** The result of a side-effect-free dry run — nothing is recorded. */
export interface RetentionPurgePreview {
  /** The reference instant the cutoffs were computed against. */
  readonly at: Date;
  /** Rows a purge would delete across every category. */
  readonly totalWouldDelete: number;
  /** Per-category projection, in {@link countExpiredRecords} order. */
  readonly items: RetentionPurgePreviewItem[];
}

/**
 * Count what {@link runRetentionPurge} would delete as of `now`, without
 * deleting anything or recording a run — the operator-confidence preview.
 */
export function previewRetentionPurge(
  db: PolicyDb,
  policy: RetentionPolicy,
  now: Date,
): RetentionPurgePreview {
  const results = countExpiredRecords(db, policy, now);
  return {
    at: now,
    totalWouldDelete: results.reduce((sum, r) => sum + r.wouldDelete, 0),
    items: results.map((r) => ({
      category: r.category,
      cutoff: r.cutoff,
      wouldDelete: r.wouldDelete,
    })),
  };
}
