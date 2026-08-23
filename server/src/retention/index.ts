/**
 * Retention barrel (#137, epic #135): the scheduled data-retention purge.
 *
 * The purge *mechanism* and *rule* live under `policy/` (`purge.ts`, #138;
 * `retention.ts`, #136); this module is the orchestration around them — the
 * service that drives + records a run and the croner scheduler that fires it on
 * a cadence, mirroring `src/enforcement/`'s split of decision vs. driver.
 */
export {
  runRetentionPurge,
  previewRetentionPurge,
  type RunRetentionPurgeOptions,
  type RetentionPurgePreview,
  type RetentionPurgePreviewItem,
} from "./service.js";
export {
  createRetentionPurgeScheduler,
  DEFAULT_RETENTION_PURGE_PATTERN,
  RETENTION_PURGE_LOG_COMPONENT,
  type RetentionPurgeSchedulerOptions,
  type RetentionPurgeSchedulerHandle,
} from "./scheduler.js";
