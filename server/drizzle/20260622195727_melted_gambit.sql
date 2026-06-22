CREATE TABLE `retention_overrides` (
	`category` text PRIMARY KEY NOT NULL,
	`keep_forever` integer DEFAULT false NOT NULL,
	`days` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "retention_overrides_category_check" CHECK("retention_overrides"."category" in ('usage_samples', 'grant_ledger', 'audit_log', 'date_overrides')),
	CONSTRAINT "retention_overrides_coherence_check" CHECK(("retention_overrides"."keep_forever" = 1 and "retention_overrides"."days" is null) or ("retention_overrides"."keep_forever" = 0 and "retention_overrides"."days" > 0))
);
