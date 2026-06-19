CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	`target_host` text NOT NULL,
	`target_port` integer NOT NULL,
	`target_user` text NOT NULL,
	`client_id` integer,
	`user_id` integer,
	`actor` text DEFAULT 'system' NOT NULL,
	`reason` text,
	`command` text NOT NULL,
	`outcome` text NOT NULL,
	`exit_code` integer,
	`signal` text,
	`duration_ms` integer NOT NULL,
	`error_message` text,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_log_outcome_check" CHECK("audit_log"."outcome" in ('ok', 'failed', 'unreachable', 'timeout', 'parse_error')),
	CONSTRAINT "audit_log_duration_check" CHECK("audit_log"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_client_at_idx` ON `audit_log` (`client_id`,`at`);