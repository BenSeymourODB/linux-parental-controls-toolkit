CREATE TABLE `group_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_group_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer,
	`action` text NOT NULL,
	`reason` text,
	`effective_from` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_exceptions_target_kind_check" CHECK("group_exceptions"."target_kind" in ('overall', 'activity', 'group')),
	CONSTRAINT "group_exceptions_action_check" CHECK("group_exceptions"."action" in ('allow', 'deny', 'extend')),
	CONSTRAINT "group_exceptions_target_coherence_check" CHECK(("group_exceptions"."target_kind" = 'overall') = ("group_exceptions"."target_id" is null)),
	CONSTRAINT "group_exceptions_effective_window_check" CHECK("group_exceptions"."effective_from" is null or "group_exceptions"."effective_from" < "group_exceptions"."expires_at")
);
--> statement-breakpoint
CREATE INDEX `group_exceptions_group_expires_idx` ON `group_exceptions` (`user_group_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `group_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_group_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer,
	`recurrence_days` integer,
	`recurrence_start_minute` integer,
	`recurrence_end_minute` integer,
	`effective_from` integer,
	`effective_to` integer,
	`action` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_schedules_target_kind_check" CHECK("group_schedules"."target_kind" in ('overall', 'activity', 'group')),
	CONSTRAINT "group_schedules_action_check" CHECK("group_schedules"."action" in ('allow', 'deny', 'extend')),
	CONSTRAINT "group_schedules_target_coherence_check" CHECK(("group_schedules"."target_kind" = 'overall') = ("group_schedules"."target_id" is null)),
	CONSTRAINT "group_schedules_recurrence_days_check" CHECK("group_schedules"."recurrence_days" is null or ("group_schedules"."recurrence_days" between 1 and 127)),
	CONSTRAINT "group_schedules_recurrence_minutes_check" CHECK(("group_schedules"."recurrence_start_minute" is null) = ("group_schedules"."recurrence_end_minute" is null) and ("group_schedules"."recurrence_start_minute" is null or ("group_schedules"."recurrence_start_minute" >= 0 and "group_schedules"."recurrence_end_minute" <= 1440 and "group_schedules"."recurrence_start_minute" < "group_schedules"."recurrence_end_minute"))),
	CONSTRAINT "group_schedules_effective_window_check" CHECK("group_schedules"."effective_from" is null or "group_schedules"."effective_to" is null or "group_schedules"."effective_from" < "group_schedules"."effective_to")
);
--> statement-breakpoint
CREATE INDEX `group_schedules_group_ordinal_idx` ON `group_schedules` (`user_group_id`,`ordinal`);