PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_policies` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sound_profile` text DEFAULT 'subtle' NOT NULL,
	`grace_seconds` integer DEFAULT 15 NOT NULL,
	`cadence_overrides_json` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_policies_sound_profile_check" CHECK("__new_notification_policies"."sound_profile" in ('off', 'subtle', 'prominent')),
	CONSTRAINT "notification_policies_grace_check" CHECK("__new_notification_policies"."grace_seconds" between 0 and 60)
);
--> statement-breakpoint
INSERT INTO `__new_notification_policies`("user_id", "enabled", "sound_profile", "grace_seconds", "cadence_overrides_json") SELECT "user_id", "enabled", "sound_profile", "grace_seconds", "cadence_overrides_json" FROM `notification_policies`;--> statement-breakpoint
DROP TABLE `notification_policies`;--> statement-breakpoint
ALTER TABLE `__new_notification_policies` RENAME TO `notification_policies`;--> statement-breakpoint
PRAGMA foreign_keys=ON;