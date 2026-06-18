CREATE TABLE `transport_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`coalesce_key` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`enqueued_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transport_queue_status_check" CHECK("transport_queue"."status" in ('pending', 'failed')),
	CONSTRAINT "transport_queue_attempts_check" CHECK("transport_queue"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transport_queue_client_coalesce_unique` ON `transport_queue` (`client_id`,`coalesce_key`);--> statement-breakpoint
CREATE INDEX `transport_queue_client_status_id_idx` ON `transport_queue` (`client_id`,`status`,`id`);