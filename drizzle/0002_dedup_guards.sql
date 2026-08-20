CREATE TABLE `merge_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_a_id` integer NOT NULL,
	`lead_b_id` integer NOT NULL,
	`score` real NOT NULL,
	`top_signal` text NOT NULL,
	`signal_value` text NOT NULL,
	`signals` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`merge_log_id` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`lead_a_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_b_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merge_log_id`) REFERENCES `merge_log`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merge_candidates_status_check" CHECK("status" in ('pending', 'merged', 'rejected')),
	CONSTRAINT "merge_candidates_signal_check" CHECK("top_signal" in ('phone', 'website_domain', 'email', 'registration_number', 'name_city', 'address', 'manual', 'social_profile'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_candidates_pair_idx` ON `merge_candidates` (`lead_a_id`,`lead_b_id`);--> statement-breakpoint
CREATE INDEX `merge_candidates_status_idx` ON `merge_candidates` (`status`,`score`);--> statement-breakpoint
CREATE INDEX `merge_candidates_lead_b_idx` ON `merge_candidates` (`lead_b_id`);--> statement-breakpoint
CREATE TABLE `shared_identifiers` (
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`distinct_leads` integer DEFAULT 0 NOT NULL,
	`distinct_businesses` integer DEFAULT 0 NOT NULL,
	`quarantined` integer DEFAULT false NOT NULL,
	`reason` text,
	`sample_names` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`note` text,
	PRIMARY KEY(`kind`, `value`),
	CONSTRAINT "shared_identifiers_kind_check" CHECK("kind" in ('phone', 'website_domain', 'email')),
	CONSTRAINT "shared_identifiers_reason_check" CHECK("reason" in ('shared_across_businesses', 'directory_owned', 'infrastructure', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `shared_identifiers_quarantined_idx` ON `shared_identifiers` (`quarantined`,`kind`);--> statement-breakpoint
ALTER TABLE `merge_log` ADD `signals` text;--> statement-breakpoint
CREATE INDEX `leads_city_idx` ON `leads` (`city_id`);