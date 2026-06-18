CREATE TABLE `enrolment_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`hostname` text,
	`supervised_users` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`consumed_at` integer,
	`consumed_client_id` integer,
	FOREIGN KEY (`consumed_client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrolment_tokens_token_hash_unique` ON `enrolment_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `clients` ADD `bearer_token_hash` text;