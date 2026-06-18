PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer,
	`action` text NOT NULL,
	`reason` text,
	`effective_from` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "exceptions_target_kind_check" CHECK("__new_exceptions"."target_kind" in ('overall', 'activity', 'group')),
	CONSTRAINT "exceptions_action_check" CHECK("__new_exceptions"."action" in ('allow', 'deny', 'extend')),
	CONSTRAINT "exceptions_target_coherence_check" CHECK(("__new_exceptions"."target_kind" = 'overall') = ("__new_exceptions"."target_id" is null)),
	CONSTRAINT "exceptions_effective_window_check" CHECK("__new_exceptions"."effective_from" is null or "__new_exceptions"."effective_from" < "__new_exceptions"."expires_at")
);
--> statement-breakpoint
-- `effective_from` is newly added here; it does not exist on the source table,
-- so it is omitted from the copy and defaults to NULL (drizzle-kit's
-- recreate-for-CHECK copy otherwise references the not-yet-existing column).
INSERT INTO `__new_exceptions`("id", "user_id", "target_kind", "target_id", "action", "reason", "expires_at", "created_at") SELECT "id", "user_id", "target_kind", "target_id", "action", "reason", "expires_at", "created_at" FROM `exceptions`;--> statement-breakpoint
DROP TABLE `exceptions`;--> statement-breakpoint
ALTER TABLE `__new_exceptions` RENAME TO `exceptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `exceptions_user_expires_idx` ON `exceptions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `__new_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer,
	`cron_or_window` text NOT NULL,
	`recurrence_days` integer,
	`recurrence_start_minute` integer,
	`recurrence_end_minute` integer,
	`effective_from` integer,
	`effective_to` integer,
	`action` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedules_target_kind_check" CHECK("__new_schedules"."target_kind" in ('overall', 'activity', 'group')),
	CONSTRAINT "schedules_action_check" CHECK("__new_schedules"."action" in ('allow', 'deny', 'extend')),
	CONSTRAINT "schedules_target_coherence_check" CHECK(("__new_schedules"."target_kind" = 'overall') = ("__new_schedules"."target_id" is null)),
	CONSTRAINT "schedules_recurrence_days_check" CHECK("__new_schedules"."recurrence_days" is null or ("__new_schedules"."recurrence_days" between 1 and 127)),
	CONSTRAINT "schedules_recurrence_minutes_check" CHECK(("__new_schedules"."recurrence_start_minute" is null) = ("__new_schedules"."recurrence_end_minute" is null) and ("__new_schedules"."recurrence_start_minute" is null or ("__new_schedules"."recurrence_start_minute" >= 0 and "__new_schedules"."recurrence_end_minute" <= 1440 and "__new_schedules"."recurrence_start_minute" < "__new_schedules"."recurrence_end_minute"))),
	CONSTRAINT "schedules_effective_window_check" CHECK("__new_schedules"."effective_from" is null or "__new_schedules"."effective_to" is null or "__new_schedules"."effective_from" < "__new_schedules"."effective_to")
);
--> statement-breakpoint
-- The recurrence/date-scoping columns are newly added here; they do not exist
-- on the source table, so they are omitted from the copy and default to NULL
-- (the always-on degenerate). Without this, drizzle-kit's recreate-for-CHECK
-- copy references not-yet-existing columns.
INSERT INTO `__new_schedules`("id", "user_id", "target_kind", "target_id", "cron_or_window", "action", "ordinal") SELECT "id", "user_id", "target_kind", "target_id", "cron_or_window", "action", "ordinal" FROM `schedules`;--> statement-breakpoint
DROP TABLE `schedules`;--> statement-breakpoint
ALTER TABLE `__new_schedules` RENAME TO `schedules`;--> statement-breakpoint
CREATE INDEX `schedules_user_ordinal_idx` ON `schedules` (`user_id`,`ordinal`);