CREATE TABLE `retention_purge_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	`trigger` text NOT NULL,
	`total_deleted` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`items` text NOT NULL,
	CONSTRAINT "retention_purge_runs_trigger_check" CHECK("retention_purge_runs"."trigger" in ('scheduled', 'manual')),
	CONSTRAINT "retention_purge_runs_total_deleted_check" CHECK("retention_purge_runs"."total_deleted" >= 0),
	CONSTRAINT "retention_purge_runs_duration_check" CHECK("retention_purge_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `retention_purge_runs_at_idx` ON `retention_purge_runs` (`at`);