PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`scope` text NOT NULL,
	`target_id` integer,
	`window` text NOT NULL,
	`seconds_allowed` integer NOT NULL,
	`recurrence_days` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budgets_scope_check" CHECK("__new_budgets"."scope" in ('overall', 'activity', 'group')),
	CONSTRAINT "budgets_window_check" CHECK("__new_budgets"."window" in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "budgets_seconds_check" CHECK("__new_budgets"."seconds_allowed" >= 0),
	CONSTRAINT "budgets_target_coherence_check" CHECK(("__new_budgets"."scope" = 'overall') = ("__new_budgets"."target_id" is null)),
	CONSTRAINT "budgets_recurrence_days_check" CHECK("__new_budgets"."recurrence_days" is null or ("__new_budgets"."recurrence_days" between 1 and 127)),
	CONSTRAINT "budgets_recurrence_daily_only_check" CHECK("__new_budgets"."recurrence_days" is null or "__new_budgets"."window" = 'daily')
);
--> statement-breakpoint
INSERT INTO `__new_budgets`("id", "user_id", "scope", "target_id", "window", "seconds_allowed") SELECT "id", "user_id", "scope", "target_id", "window", "seconds_allowed" FROM `budgets`;--> statement-breakpoint
DROP TABLE `budgets`;--> statement-breakpoint
ALTER TABLE `__new_budgets` RENAME TO `budgets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `budgets_user_scope_window_idx` ON `budgets` (`user_id`,`scope`,`window`);--> statement-breakpoint
CREATE TABLE `__new_group_budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_group_id` integer NOT NULL,
	`scope` text NOT NULL,
	`target_id` integer,
	`window` text NOT NULL,
	`seconds_allowed` integer NOT NULL,
	`recurrence_days` integer,
	FOREIGN KEY (`user_group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_budgets_scope_check" CHECK("__new_group_budgets"."scope" in ('overall', 'activity', 'group')),
	CONSTRAINT "group_budgets_window_check" CHECK("__new_group_budgets"."window" in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "group_budgets_seconds_check" CHECK("__new_group_budgets"."seconds_allowed" >= 0),
	CONSTRAINT "group_budgets_target_coherence_check" CHECK(("__new_group_budgets"."scope" = 'overall') = ("__new_group_budgets"."target_id" is null)),
	CONSTRAINT "group_budgets_recurrence_days_check" CHECK("__new_group_budgets"."recurrence_days" is null or ("__new_group_budgets"."recurrence_days" between 1 and 127)),
	CONSTRAINT "group_budgets_recurrence_daily_only_check" CHECK("__new_group_budgets"."recurrence_days" is null or "__new_group_budgets"."window" = 'daily')
);
--> statement-breakpoint
INSERT INTO `__new_group_budgets`("id", "user_group_id", "scope", "target_id", "window", "seconds_allowed") SELECT "id", "user_group_id", "scope", "target_id", "window", "seconds_allowed" FROM `group_budgets`;--> statement-breakpoint
DROP TABLE `group_budgets`;--> statement-breakpoint
ALTER TABLE `__new_group_budgets` RENAME TO `group_budgets`;--> statement-breakpoint
CREATE INDEX `group_budgets_group_scope_window_idx` ON `group_budgets` (`user_group_id`,`scope`,`window`);