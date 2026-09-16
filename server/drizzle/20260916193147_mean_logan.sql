ALTER TABLE `clients` ADD `last_verified_at` integer;--> statement-breakpoint
ALTER TABLE `clients` ADD `last_verify_reachable` integer;--> statement-breakpoint
ALTER TABLE `clients` ADD `last_verify_reason` text;