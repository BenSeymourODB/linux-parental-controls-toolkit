CREATE TABLE `group_budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_group_id` integer NOT NULL,
	`scope` text NOT NULL,
	`target_id` integer,
	`window` text NOT NULL,
	`seconds_allowed` integer NOT NULL,
	FOREIGN KEY (`user_group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_budgets_scope_check" CHECK("group_budgets"."scope" in ('overall', 'activity', 'group')),
	CONSTRAINT "group_budgets_window_check" CHECK("group_budgets"."window" in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "group_budgets_seconds_check" CHECK("group_budgets"."seconds_allowed" >= 0),
	CONSTRAINT "group_budgets_target_coherence_check" CHECK(("group_budgets"."scope" = 'overall') = ("group_budgets"."target_id" is null))
);
--> statement-breakpoint
CREATE INDEX `group_budgets_group_scope_window_idx` ON `group_budgets` (`user_group_id`,`scope`,`window`);