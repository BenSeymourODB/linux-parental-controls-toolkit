PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users_on_clients` (
	`user_id` integer NOT NULL,
	`client_id` integer NOT NULL,
	`os_username` text NOT NULL,
	`os_user_ref` text NOT NULL,
	PRIMARY KEY(`user_id`, `client_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Hand-fixed (#230): the generated SELECT named the post-rename columns on both
-- sides; copy from the pre-existing `linux_username`/`linux_uid` columns instead
-- so existing rows survive the rename. `os_user_ref` is TEXT, so the integer
-- `linux_uid` is coerced to its decimal-string form on insert (TEXT affinity).
INSERT INTO `__new_users_on_clients`("user_id", "client_id", "os_username", "os_user_ref") SELECT "user_id", "client_id", "linux_username", "linux_uid" FROM `users_on_clients`;--> statement-breakpoint
DROP TABLE `users_on_clients`;--> statement-breakpoint
ALTER TABLE `__new_users_on_clients` RENAME TO `users_on_clients`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `users_on_clients_client_idx` ON `users_on_clients` (`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_on_clients_client_user_ref_unique` ON `users_on_clients` (`client_id`,`os_user_ref`);