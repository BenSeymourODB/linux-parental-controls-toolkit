/**
 * Retention configuration + purge routes (#136/#137): the admin-only surface for
 * data-retention windows and the manual purge/preview controls.
 *
 * - `GET /api/retention` — the full config: the global default plus every
 *   category's effective entry (override or default-inherited).
 * - `PUT /api/retention/:category` — pin an override (custom window | keep
 *   forever).
 * - `DELETE /api/retention/:category` — clear an override, reverting the
 *   category to the global default. Idempotent: clearing a category that has
 *   no override is a no-op that still returns the resulting default entry.
 * - `POST /api/retention/purge` — run the purge now (recorded as a `manual`
 *   run); returns the recorded run.
 * - `POST /api/retention/purge/preview` — a side-effect-free dry run: count
 *   what *would* be purged; deletes and records nothing.
 * - `GET /api/retention/purge/runs?limit=` — recent runs, newest first
 *   (`runs[0]` is the last-run summary the admin page shows).
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so it
 * inherits the zod validator + shared error envelope and sits behind
 * `requireAdmin` — retention windows are admin-only (`CLAUDE.md` → "no
 * privileged in-process shortcuts"). Handlers stay thin: validate, read/write
 * via the `policy/repository` over `app.db`, serialise. The global default
 * comes from `settings` (`PCT_RETENTION_DEFAULT_DAYS`); only per-category
 * overrides are persisted.
 *
 * The Svelte admin view that consumes this contract is `RetentionView`
 * (`/admin` retention page): the windows editor (#214) plus the data-purge
 * panel (#137, last-run summary + preview + run-now).
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import type { Settings } from "../../config.js";
import { retentionCategoryValues } from "../../policy/enums.js";
import {
  deleteRetentionOverride,
  listPurgeRuns,
  listRetentionOverrides,
  upsertRetentionOverride,
} from "../../policy/repository.js";
import { RetentionPolicy } from "../../policy/retention.js";
import { previewRetentionPurge, runRetentionPurge } from "../../retention/index.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  defaultEntry,
  retentionCategoryParamsSchema,
  retentionPurgeRunsQuerySchema,
  setRetentionOverrideSchema,
  toOverrideEntry,
  toPurgePreviewResponse,
  toPurgeRunResponse,
  toRetentionConfigResponse,
  type RetentionConfigResponse,
  type RetentionEntryResponse,
  type RetentionPurgePreviewResponse,
  type RetentionPurgeRunResponse,
  type RetentionPurgeRunsResponse,
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

  // The effective policy is built per request from the env default + the
  // persisted overrides, so a purge/preview always reflects the latest windows
  // (the same rebuild the scheduler does each tick).
  const effectivePolicy = (): RetentionPolicy =>
    RetentionPolicy.fromOverrides(defaultDays, listRetentionOverrides(scope.db));

  typed.post(
    "/retention/purge",
    { preHandler: scope.requireAdmin },
    async (): Promise<RetentionPurgeRunResponse> => {
      const row = runRetentionPurge(scope.db, effectivePolicy(), new Date(), {
        trigger: "manual",
        batchSize: settings.retention.purgeBatchSize,
      });
      return toPurgeRunResponse(row);
    },
  );

  typed.post(
    "/retention/purge/preview",
    { preHandler: scope.requireAdmin },
    async (): Promise<RetentionPurgePreviewResponse> =>
      toPurgePreviewResponse(previewRetentionPurge(scope.db, effectivePolicy(), new Date())),
  );

  typed.get(
    "/retention/purge/runs",
    { preHandler: scope.requireAdmin, schema: { querystring: retentionPurgeRunsQuerySchema } },
    async (request): Promise<RetentionPurgeRunsResponse> => ({
      runs: listPurgeRuns(scope.db, request.query.limit).map(toPurgeRunResponse),
    }),
  );
}
