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

import { retentionCategorySchema } from "../../policy/enums.js";
import type { RetentionOverrideRow } from "../../policy/repository.js";
import { MAX_RETENTION_DAYS } from "../../policy/retention.js";

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
  /** The window in days, or `null` when `keepForever`. */
  days: z.number().int().nullable(),
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
 * shows it, the rest inherit the default. Category order follows the rows'
 * `ORDER BY category` for the overridden ones; callers pass all categories via
 * {@link allCategoriesResponse} when they want the complete, ordered set.
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
