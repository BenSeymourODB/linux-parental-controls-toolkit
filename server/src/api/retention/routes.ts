/**
 * Retention configuration routes (#136): the admin-only read/write surface for
 * data-retention windows.
 *
 * - `GET /api/retention` — the full config: the global default plus every
 *   category's effective entry (override or default-inherited).
 * - `PUT /api/retention/:category` — pin an override (custom window | keep
 *   forever).
 * - `DELETE /api/retention/:category` — clear an override, reverting the
 *   category to the global default. Idempotent: clearing a category that has
 *   no override is a no-op that still returns the resulting default entry.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so it
 * inherits the zod validator + shared error envelope and sits behind
 * `requireAdmin` — retention windows are admin-only (`CLAUDE.md` → "no
 * privileged in-process shortcuts"). Handlers stay thin: validate, read/write
 * via the `policy/repository` over `app.db`, serialise. The global default
 * comes from `settings` (`PCT_RETENTION_DEFAULT_DAYS`); only per-category
 * overrides are persisted.
 *
 * The Svelte admin view that consumes this contract is deferred to its own
 * issue (it depends on the `/admin/*` shell, #53).
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import type { Settings } from "../../config.js";
import { retentionCategoryValues } from "../../policy/enums.js";
import {
  deleteRetentionOverride,
  listRetentionOverrides,
  upsertRetentionOverride,
} from "../../policy/repository.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  defaultEntry,
  retentionCategoryParamsSchema,
  setRetentionOverrideSchema,
  toOverrideEntry,
  toRetentionConfigResponse,
  type RetentionConfigResponse,
  type RetentionEntryResponse,
} from "./dtos.js";

/**
 * Register the retention config routes on an already-`/api`-prefixed scope.
 * Call after {@link registerAuth} so `scope.requireAdmin` is decorated;
 * `settings` carries the global default window.
 */
export function registerRetentionRoutes(scope: FastifyInstance, settings: Settings): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const defaultDays = settings.retention.defaultDays;

  typed.get(
    "/retention",
    { preHandler: scope.requireAdmin },
    async (): Promise<RetentionConfigResponse> =>
      toRetentionConfigResponse(
        defaultDays,
        retentionCategoryValues,
        listRetentionOverrides(scope.db),
      ),
  );

  typed.put(
    "/retention/:category",
    {
      preHandler: scope.requireAdmin,
      schema: { params: retentionCategoryParamsSchema, body: setRetentionOverrideSchema },
    },
    async (request): Promise<RetentionEntryResponse> => {
      const row = upsertRetentionOverride(scope.db, request.params.category, request.body);
      return toOverrideEntry(row);
    },
  );

  typed.delete(
    "/retention/:category",
    { preHandler: scope.requireAdmin, schema: { params: retentionCategoryParamsSchema } },
    async (request): Promise<RetentionEntryResponse> => {
      deleteRetentionOverride(scope.db, request.params.category);
      return defaultEntry(request.params.category, defaultDays);
    },
  );
}
