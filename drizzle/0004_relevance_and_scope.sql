-- FUZZ-37: two scores instead of one, and `UNKNOWN` split in two.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Three
-- things happen in the copy below and each is deliberate:
--
--   1. `classification = 'UNKNOWN'` becomes `'UNCLASSIFIED'`. Every stored
--      UNKNOWN row is "we found nothing" until the classifier is re-run; the
--      rows that are really `OUT_OF_SCOPE` get that label from the re-grade,
--      not from a guess in a migration.
--   2. `classification_industry` starts NULL. It is only meaningful next to an
--      `OUT_OF_SCOPE` label, which no stored row carries yet.
--   3. `relevance_score`, `contactability_score` and `lead_score` start at 0.
--      The old `lead_score` was 66% contact completeness and 14% relevance on
--      a scale that no longer exists — carrying it into a column that now
--      means `relevance × contactability / 100` would be a number nobody
--      could read and everybody would trust. Run
--      `npx tsx scripts/fuzz37-regrade.ts <db>` after migrating; it re-runs
--      `classifyLead` and `scoreLead` over every lead and fills all four.
--
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`legal_form` text,
	`registration_number` text,
	`tax_id` text,
	`classification` text DEFAULT 'UNCLASSIFIED' NOT NULL,
	`classification_confidence` real,
	`classification_evidence` text,
	`classification_industry` text,
	`city_id` text,
	`municipality_id` text,
	`city_raw` text,
	`address` text,
	`address_normalized` text,
	`postal_code` text,
	`latitude` real,
	`longitude` real,
	`description` text,
	`opening_hours` text,
	`relevance_score` integer DEFAULT 0 NOT NULL,
	`relevance_breakdown` text,
	`contactability_score` integer DEFAULT 0 NOT NULL,
	`score_breakdown` text,
	`lead_score` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`review_note` text,
	`reviewed_at` integer,
	`merged_into_id` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_scraped_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merged_into_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "leads_classification_check" CHECK("classification" in ('FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE', 'BOTH', 'UNCLASSIFIED', 'OUT_OF_SCOPE')),
	CONSTRAINT "leads_industry_check" CHECK("classification_industry" is null or "classification_industry" in ('roofing', 'joinery', 'waterproofing', 'industrial_insulation', 'electrical', 'cleaning', 'manufacturing', 'other_trade', 'general_construction', 'technical_goods')),
	CONSTRAINT "leads_status_check" CHECK("status" in ('new', 'reviewed', 'approved', 'rejected', 'merged'))
);
--> statement-breakpoint
INSERT INTO `__new_leads`("id", "name", "name_normalized", "legal_form", "registration_number", "tax_id", "classification", "classification_confidence", "classification_evidence", "classification_industry", "city_id", "municipality_id", "city_raw", "address", "address_normalized", "postal_code", "latitude", "longitude", "description", "opening_hours", "relevance_score", "relevance_breakdown", "contactability_score", "score_breakdown", "lead_score", "status", "review_note", "reviewed_at", "merged_into_id", "first_seen_at", "last_seen_at", "last_scraped_at", "created_at", "updated_at") SELECT "id", "name", "name_normalized", "legal_form", "registration_number", "tax_id", CASE WHEN "classification" = 'UNKNOWN' THEN 'UNCLASSIFIED' ELSE "classification" END, "classification_confidence", "classification_evidence", NULL, "city_id", "municipality_id", "city_raw", "address", "address_normalized", "postal_code", "latitude", "longitude", "description", "opening_hours", 0, NULL, 0, "score_breakdown", 0, "status", "review_note", "reviewed_at", "merged_into_id", "first_seen_at", "last_seen_at", "last_scraped_at", "created_at", "updated_at" FROM `leads`;--> statement-breakpoint
DROP TABLE `leads`;--> statement-breakpoint
ALTER TABLE `__new_leads` RENAME TO `leads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `leads_name_city_idx` ON `leads` (`name_normalized`,`city_id`);--> statement-breakpoint
CREATE INDEX `leads_name_idx` ON `leads` (`name_normalized`);--> statement-breakpoint
CREATE INDEX `leads_registration_idx` ON `leads` (`registration_number`);--> statement-breakpoint
CREATE INDEX `leads_classification_status_idx` ON `leads` (`classification`,`status`,`lead_score`);--> statement-breakpoint
CREATE INDEX `leads_relevance_idx` ON `leads` (`relevance_score`);--> statement-breakpoint
CREATE INDEX `leads_contactability_idx` ON `leads` (`contactability_score`);--> statement-breakpoint
CREATE INDEX `leads_merged_into_idx` ON `leads` (`merged_into_id`);--> statement-breakpoint
CREATE INDEX `leads_city_idx` ON `leads` (`city_id`);--> statement-breakpoint
CREATE INDEX `leads_last_scraped_idx` ON `leads` (`last_scraped_at`);