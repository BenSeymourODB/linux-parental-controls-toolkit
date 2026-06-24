PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hostname` text NOT NULL,
	`ssh_user` text NOT NULL,
	`bearer_token_hash` text,
	`enrolled_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer,
	`agent_version` text,
	`component_versions` text,
	`versions_reported_at` integer,
	`platform` text DEFAULT 'linux' NOT NULL,
	CONSTRAINT "clients_platform_check" CHECK("__new_clients"."platform" in ('linux', 'windows'))
);
--> statement-breakpoint
-- Hand-fix (#229): drizzle-kit's generated copy lists the new `platform` column, but the old
-- `clients` table predates it — copying it would fail with "no such column". Copy only the
-- pre-existing columns so existing rows take the `DEFAULT 'linux'`. Same table-recreate pattern
-- as #146 (recurrence) and #178 (match_type); locked by tests/policy/migrations.test.ts.
INSERT INTO `__new_clients`("id", "hostname", "ssh_user", "bearer_token_hash", "enrolled_at", "last_seen", "agent_version", "component_versions", "versions_reported_at") SELECT "id", "hostname", "ssh_user", "bearer_token_hash", "enrolled_at", "last_seen", "agent_version", "component_versions", "versions_reported_at" FROM `clients`;--> statement-breakpoint
DROP TABLE `clients`;--> statement-breakpoint
ALTER TABLE `__new_clients` RENAME TO `clients`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `clients_hostname_unique` ON `clients` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `clients_bearer_token_hash_unique` ON `clients` (`bearer_token_hash`);