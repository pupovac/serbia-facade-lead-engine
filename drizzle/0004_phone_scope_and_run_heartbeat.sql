ALTER TABLE `crawl_runs` ADD `heartbeat_at` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lead_phones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`e164` text NOT NULL,
	`raw` text NOT NULL,
	`national_format` text,
	`type` text DEFAULT 'unknown' NOT NULL,
	`scope` text DEFAULT 'business' NOT NULL,
	`label` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`valid` integer DEFAULT true NOT NULL,
	`confidence` real,
	`source_id` text NOT NULL,
	`source_url` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lead_phones_type_check" CHECK("type" in ('mobile', 'landline', 'toll_free', 'voip', 'unknown')),
	CONSTRAINT "lead_phones_scope_check" CHECK("scope" in ('business', 'branch'))
);
--> statement-breakpoint
INSERT INTO `__new_lead_phones`("id", "lead_id", "e164", "raw", "national_format", "type", "scope", "label", "is_primary", "valid", "confidence", "source_id", "source_url", "first_seen_at", "last_seen_at") SELECT "id", "lead_id", "e164", "raw", "national_format", "type", 'business', NULL, "is_primary", "valid", "confidence", "source_id", "source_url", "first_seen_at", "last_seen_at" FROM `lead_phones`;--> statement-breakpoint
DROP TABLE `lead_phones`;--> statement-breakpoint
ALTER TABLE `__new_lead_phones` RENAME TO `lead_phones`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `lead_phones_e164_idx` ON `lead_phones` (`e164`);--> statement-breakpoint
CREATE INDEX `lead_phones_lead_idx` ON `lead_phones` (`lead_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_phones_claim_idx` ON `lead_phones` (`lead_id`,`e164`,`source_id`);