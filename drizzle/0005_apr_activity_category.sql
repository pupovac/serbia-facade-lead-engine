-- FUZZ-46: the APR activity category, carried to the leads table.
--
-- Additive and nullable. `leads` gains two columns and takes a plain
-- `ALTER TABLE ... ADD` — no rebuild, no backfill, no default. Every source
-- other than `kompanije-net` leaves both null, and that is the intended state:
-- null means "this source does not publish an activity code", not "unknown".
--
-- Two columns rather than one, because they answer different questions. The
-- four-digit code (`4331`) is what a filter and a join key needs; the name
-- (`Malterisanje`) is what the member reads in the XLSX export.
--
-- `lead_field_values` is rebuilt only because SQLite cannot alter a CHECK
-- constraint and the two new provenance fields have to be inside it. Every row
-- is copied verbatim; nothing is reinterpreted.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lead_field_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`value_normalized` text,
	`is_current` integer DEFAULT false NOT NULL,
	`confidence` real,
	`source_id` text NOT NULL,
	`source_url` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lead_field_values_field_check" CHECK("field" in ('name', 'legal_form', 'address', 'postal_code', 'city', 'municipality', 'classification', 'description', 'opening_hours', 'registration_number', 'tax_id', 'coordinates', 'activity_code', 'activity_name'))
);
--> statement-breakpoint
INSERT INTO `__new_lead_field_values`("id", "lead_id", "field", "value", "value_normalized", "is_current", "confidence", "source_id", "source_url", "first_seen_at", "last_seen_at") SELECT "id", "lead_id", "field", "value", "value_normalized", "is_current", "confidence", "source_id", "source_url", "first_seen_at", "last_seen_at" FROM `lead_field_values`;--> statement-breakpoint
DROP TABLE `lead_field_values`;--> statement-breakpoint
ALTER TABLE `__new_lead_field_values` RENAME TO `lead_field_values`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `lead_field_values_lead_idx` ON `lead_field_values` (`lead_id`,`field`);--> statement-breakpoint
CREATE INDEX `lead_field_values_current_idx` ON `lead_field_values` (`lead_id`,`is_current`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_field_values_claim_idx` ON `lead_field_values` (`lead_id`,`field`,`value`,`source_id`);--> statement-breakpoint
ALTER TABLE `leads` ADD `activity_code` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `activity_name` text;--> statement-breakpoint
CREATE INDEX `leads_activity_code_idx` ON `leads` (`activity_code`);