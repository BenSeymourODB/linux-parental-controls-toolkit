CREATE TABLE `activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`matcher` text NOT NULL,
	CONSTRAINT "activities_kind_check" CHECK("activities"."kind" in ('app', 'app_group', 'domain', 'domain_group'))
);
--> statement-breakpoint
CREATE TABLE `activities_to_groups` (
	`activity_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	PRIMARY KEY(`activity_id`, `group_id`),
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `activity_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `activity_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_groups_name_unique` ON `activity_groups` (`name`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`scope` text NOT NULL,
	`target_id` integer,
	`window` text NOT NULL,
	`seconds_allowed` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budgets_scope_check" CHECK("budgets"."scope" in ('overall', 'activity', 'group')),
	CONSTRAINT "budgets_window_check" CHECK("budgets"."window" in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "budgets_seconds_check" CHECK("budgets"."seconds_allowed" >= 0),
	CONSTRAINT "budgets_target_coherence_check" CHECK(("budgets"."scope" = 'overall') = ("budgets"."target_id" is null))
);
--> statement-breakpoint
CREATE INDEX `budgets_user_scope_window_idx` ON `budgets` (`user_id`,`scope`,`window`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hostname` text NOT NULL,
	`ssh_user` text NOT NULL,
	`enrolled_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_hostname_unique` ON `clients` (`hostname`);--> statement-breakpoint
CREATE TABLE `exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer,
	`action` text NOT NULL,
	`reason` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "exceptions_target_kind_check" CHECK("exceptions"."target_kind" in ('overall', 'activity', 'group')),
	CONSTRAINT "exceptions_action_check" CHECK("exceptions"."action" in ('allow', 'deny', 'extend')),
	CONSTRAINT "exceptions_target_coherence_check" CHECK(("exceptions"."target_kind" = 'overall') = ("exceptions"."target_id" is null))
);
--> statement-breakpoint
CREATE INDEX `exceptions_user_expires_idx` ON `exceptions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`scope` text NOT NULL,
	`target_id` integer,
	`seconds_granted` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`reason` text,
	`granted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "grants_scope_check" CHECK("grants"."scope" in ('overall', 'activity', 'group')),
	CONSTRAINT "grants_seconds_check" CHECK("grants"."seconds_granted" > 0),
	CONSTRAINT "grants_target_coherence_check" CHECK(("grants"."scope" = 'overall') = ("grants"."target_id" is null)),
	CONSTRAINT "grants_source_check" CHECK("grants"."source" = 'admin' or "grants"."source" like 'integration:%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_source_ref_unique` ON `grants` (`source_ref`);--> statement-breakpoint
CREATE INDEX `grants_user_scope_target_idx` ON `grants` (`user_id`,`scope`,`target_id`);--> statement-breakpoint
CREATE INDEX `grants_user_expires_idx` ON `grants` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `integration_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`scopes` text NOT NULL,
	`hashed_secret` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_tokens_name_unique` ON `integration_tokens` (`name`);--> statement-breakpoint
CREATE TABLE `notification_policies` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sound_profile` text DEFAULT 'default' NOT NULL,
	`grace_seconds` integer DEFAULT 60 NOT NULL,
	`cadence_overrides_json` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_policies_grace_check" CHECK("notification_policies"."grace_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer,
	`cron_or_window` text NOT NULL,
	`action` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedules_target_kind_check" CHECK("schedules"."target_kind" in ('overall', 'activity', 'group')),
	CONSTRAINT "schedules_action_check" CHECK("schedules"."action" in ('allow', 'deny', 'extend')),
	CONSTRAINT "schedules_target_coherence_check" CHECK(("schedules"."target_kind" = 'overall') = ("schedules"."target_id" is null))
);
--> statement-breakpoint
CREATE INDEX `schedules_user_idx` ON `schedules` (`user_id`);--> statement-breakpoint
CREATE TABLE `usage_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`client_id` integer NOT NULL,
	`activity_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "usage_samples_interval_check" CHECK("usage_samples"."ended_at" >= "usage_samples"."started_at")
);
--> statement-breakpoint
CREATE INDEX `usage_samples_user_started_idx` ON `usage_samples` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `usage_samples_user_activity_started_idx` ON `usage_samples` (`user_id`,`activity_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`tz` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users_on_clients` (
	`user_id` integer NOT NULL,
	`client_id` integer NOT NULL,
	`linux_username` text NOT NULL,
	`linux_uid` integer NOT NULL,
	PRIMARY KEY(`user_id`, `client_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `users_on_clients_client_idx` ON `users_on_clients` (`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_on_clients_client_uid_unique` ON `users_on_clients` (`client_id`,`linux_uid`);
