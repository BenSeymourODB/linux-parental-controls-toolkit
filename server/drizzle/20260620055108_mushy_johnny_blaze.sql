PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`matcher` text NOT NULL,
	`match_type` text DEFAULT 'exact' NOT NULL,
	CONSTRAINT "activities_kind_check" CHECK("__new_activities"."kind" in ('app', 'app_group', 'domain', 'domain_group')),
	CONSTRAINT "activities_match_type_check" CHECK("__new_activities"."match_type" in ('exact', 'substring', 'glob', 'regex'))
);
--> statement-breakpoint
--> hand-fix (drizzle-kit SQLite recreate limitation, cf. #146/messy_sleepwalker):
--> the recreate exists only to add the `match_type` CHECK; the column is new, so
--> the copy selects only the pre-existing columns and lets `match_type` take its
--> DEFAULT 'exact' for every existing row (selecting the new column from the old
--> table would fail). ADR 0006 degenerate default.
INSERT INTO `__new_activities`("id", "kind", "matcher") SELECT "id", "kind", "matcher" FROM `activities`;--> statement-breakpoint
DROP TABLE `activities`;--> statement-breakpoint
ALTER TABLE `__new_activities` RENAME TO `activities`;--> statement-breakpoint
PRAGMA foreign_keys=ON;