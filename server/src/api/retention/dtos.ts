/**
 * zod DTOs for the retention configuration API (#136), shared with the
 * frontend and external integrators (the single `/api/*` contract).
 *
 * The wire model mirrors the two-layer config in `policy/retention.ts`: a
 * global default window plus per-category overrides. A category's entry is
 * either inherited from the default (`source: "default"`) or pinned by an
 * override (`source: "override"`, either a custom day count or keep-forever).
 * Timestamps serialise as ISO-8601 strings (storage keeps UTC epoch seconds).
 */
import { z } from "zod";

import { retentionCategorySchema, retentionPurgeTriggerSchema } from "../../policy/enums.js";
import type { RetentionOverrideRow, RetentionPurgeRunRow } from "../../policy/repository.js";
import { MAX_RETENTION_DAYS } from "../../policy/retention.js";
import type { RetentionPurgePreview } from "../../retention/index.js";

/** Path params for the per-category routes: `/api/retention/:category`. */
export const retentionCategoryParamsSchema = z.object({
  category: retentionCategorySchema,
});

/** The inferred, validated category path params. */
export type RetentionCategoryParams = z.infer<typeof retentionCategoryParamsSchema>;

/**
 * Body for `PUT /api/retention/:category`. A discriminated union on
 * `keepForever` so the two modes can't be mixed: keep-forever carries no day
 * count; a custom window carries a strictly-positive, bounded one (the same
 * bound the settings default and the storage layer enforce). This is the API
 * counterpart of {@link ResolvedRetention}.
 */
export const setRetentionOverrideSchema = z.discriminatedUnion("keepForever", [
  z.object({ keepForever: z.literal(true) }),
  z.object({
    keepForever: z.literal(false),
    days: z.number().int().min(1).max(MAX_RETENTION_DAYS),
  }),
]);

/** The inferred, validated set-override request. */
export type SetRetentionOverrideRequest = z.infer<typeof setRetentionOverrideSchema>;

/** One category's effective retention on the wire. */
export const retentionEntryResponseSchema = z.object({
  category: retentionCategorySchema,
  /** Whether this entry is inherited from the default or pinned by an override. */
  source: z.enum(["default", "override"]),
  keepForever: z.boolean(),
  /** The window in days (positive), or `null` when `keepForever`. Mirrors the write contract's bound. */
  days: z.number().int().positive().nullable(),
  /** When the override was last changed; `null` for a default-inherited entry. */
  updatedAt: z.string().nullable(),
});

/** The inferred shape of one retention entry. */
export type RetentionEntryResponse = z.infer<typeof retentionEntryResponseSchema>;

/** The full retention config: the global default plus every category's entry. */
export const retentionConfigResponseSchema = z.object({
  defaultDays: z.number().int(),
  categories: z.array(retentionEntryResponseSchema),
});

/** The inferred shape of the retention config response. */
export type RetentionConfigResponse = z.infer<typeof retentionConfigResponseSchema>;

/** Serialise an override row to its wire entry (`source: "override"`). */
export function toOverrideEntry(row: RetentionOverrideRow): RetentionEntryResponse {
  return {
    category: row.category,
    source: "override",
    keepForever: row.keepForever,
    days: row.days,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The wire entry for a category inheriting the global default. */
export function defaultEntry(
  category: RetentionEntryResponse["category"],
  defaultDays: number,
): RetentionEntryResponse {
  return { category, source: "default", keepForever: false, days: defaultDays, updatedAt: null };
}

/**
 * Build the full config response from the global default and the override rows.
 * Every known category appears exactly once: a category with an override row
 * shows it, the rest inherit the default. Output order follows the passed
 * `categories` array (the route passes `retentionCategoryValues`, i.e.
 * declaration order); the rows' SQL order is irrelevant since they are looked
 * up by category.
 */
export function toRetentionConfigResponse(
  defaultDays: number,
  categories: readonly RetentionEntryResponse["category"][],
  rows: readonly RetentionOverrideRow[],
): RetentionConfigResponse {
  const byCategory = new Map(rows.map((row) => [row.category, toOverrideEntry(row)]));
  return {
    defaultDays,
    categories: categories.map(
      (category) => byCategory.get(category) ?? defaultEntry(category, defaultDays),
    ),
  };
}

// --- Purge runs & preview (#137) -------------------------------------------

/**
 * One category's outcome in a recorded purge run on the wire. `cutoff` is an
 * ISO-8601 string (storage keeps epoch seconds) or `null` when the category is
 * kept forever; `deleted` is the rows removed.
 */
export const retentionPurgeRunItemSchema = z.object({
  category: retentionCategorySchema,
  cutoff: z.string().nullable(),
  deleted: z.number().int().nonnegative(),
});

/** A recorded purge run on the wire (the "last run" the admin page shows). */
export const retentionPurgeRunResponseSchema = z.object({
  id: z.number().int().positive(),
  at: z.string(),
  trigger: retentionPurgeTriggerSchema,
  totalDeleted: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  items: z.array(retentionPurgeRunItemSchema),
});

/** The inferred shape of one recorded purge run. */
export type RetentionPurgeRunResponse = z.infer<typeof retentionPurgeRunResponseSchema>;

/** A page of recent purge runs, newest first (`runs[0]` is the last run). */
export const retentionPurgeRunsResponseSchema = z.object({
  runs: z.array(retentionPurgeRunResponseSchema),
});

/** The inferred shape of the purge-runs listing. */
export type RetentionPurgeRunsResponse = z.infer<typeof retentionPurgeRunsResponseSchema>;

/** Query for `GET /api/retention/purge/runs`: how many recent runs to return. */
export const retentionPurgeRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** The inferred, validated runs-listing query. */
export type RetentionPurgeRunsQuery = z.infer<typeof retentionPurgeRunsQuerySchema>;

/** One category's dry-run projection on the wire. */
export const retentionPurgePreviewItemSchema = z.object({
  category: retentionCategorySchema,
  cutoff: z.string().nullable(),
  wouldDelete: z.number().int().nonnegative(),
});

/** A side-effect-free dry-run result on the wire. */
export const retentionPurgePreviewResponseSchema = z.object({
  at: z.string(),
  totalWouldDelete: z.number().int().nonnegative(),
  items: z.array(retentionPurgePreviewItemSchema),
});

/** The inferred shape of a purge preview. */
export type RetentionPurgePreviewResponse = z.infer<typeof retentionPurgePreviewResponseSchema>;

/** An epoch-seconds cutoff (as stored) → ISO-8601 string, or `null` passthrough. */
function epochSecondsToIso(cutoff: number | null): string | null {
  return cutoff === null ? null : new Date(cutoff * 1000).toISOString();
}

/** Serialise a stored purge-run row to its wire shape (cutoffs → ISO strings). */
export function toPurgeRunResponse(row: RetentionPurgeRunRow): RetentionPurgeRunResponse {
  return {
    id: row.id,
    at: row.at.toISOString(),
    trigger: row.trigger,
    totalDeleted: row.totalDeleted,
    durationMs: row.durationMs,
    items: row.items.map((item) => ({
      category: item.category,
      cutoff: epochSecondsToIso(item.cutoff),
      deleted: item.deleted,
    })),
  };
}

/** Serialise a service-layer preview to its wire shape (cutoff Dates → ISO). */
export function toPurgePreviewResponse(
  preview: RetentionPurgePreview,
): RetentionPurgePreviewResponse {
  return {
    at: preview.at.toISOString(),
    totalWouldDelete: preview.totalWouldDelete,
    items: preview.items.map((item) => ({
      category: item.category,
      cutoff: item.cutoff === null ? null : item.cutoff.toISOString(),
      wouldDelete: item.wouldDelete,
    })),
  };
}
