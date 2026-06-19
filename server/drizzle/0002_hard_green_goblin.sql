DROP INDEX `schedules_user_idx`;--> statement-breakpoint
ALTER TABLE `schedules` ADD `ordinal` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `schedules_user_ordinal_idx` ON `schedules` (`user_id`,`ordinal`);