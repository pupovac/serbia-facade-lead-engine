CREATE TABLE `crawl_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`scope` text,
	`requests_made` integer DEFAULT 0 NOT NULL,
	`pages_fetched` integer DEFAULT 0 NOT NULL,
	`records_emitted` integer DEFAULT 0 NOT NULL,
	`records_rejected` integer DEFAULT 0 NOT NULL,
	`leads_created` integer DEFAULT 0 NOT NULL,
	`leads_updated` integer DEFAULT 0 NOT NULL,
	`phones_added` integer DEFAULT 0 NOT NULL,
	`merges_performed` integer DEFAULT 0 NOT NULL,
	`error` text,
	`notes` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crawl_runs_status_check" CHECK("status" in ('running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `crawl_runs_source_idx` ON `crawl_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `crawl_runs_status_idx` ON `crawl_runs` (`status`);--> statement-breakpoint
CREATE TABLE `crawl_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`cursor` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_run_id` integer,
	`last_error` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crawl_state_status_check" CHECK("status" in ('pending', 'in_progress', 'done', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crawl_state_scope_idx` ON `crawl_state` (`source_id`,`scope_key`);--> statement-breakpoint
CREATE INDEX `crawl_state_status_idx` ON `crawl_state` (`status`,`source_id`);--> statement-breakpoint
CREATE TABLE `erasure_blocklist` (
	`phone_sha256` text PRIMARY KEY NOT NULL,
	`erased_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `erasure_blocklist_erased_at_idx` ON `erasure_blocklist` (`erased_at`);--> statement-breakpoint
CREATE TABLE `erasure_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`erased_lead_id` integer NOT NULL,
	`reason` text NOT NULL,
	`requested_by` text,
	`rows_deleted` text,
	`erased_at` integer NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `erasure_log_lead_idx` ON `erasure_log` (`erased_lead_id`);--> statement-breakpoint
CREATE TABLE `lead_contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`value_raw` text NOT NULL,
	`domain` text,
	`handle` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`valid` integer DEFAULT true NOT NULL,
	`confidence` real,
	`source_id` text NOT NULL,
	`source_url` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lead_contacts_kind_check" CHECK("kind" in ('email', 'website', 'facebook', 'instagram', 'google_maps', 'linkedin', 'youtube', 'other'))
);
--> statement-breakpoint
CREATE INDEX `lead_contacts_domain_idx` ON `lead_contacts` (`domain`);--> statement-breakpoint
CREATE INDEX `lead_contacts_kind_value_idx` ON `lead_contacts` (`kind`,`value`);--> statement-breakpoint
CREATE INDEX `lead_contacts_lead_idx` ON `lead_contacts` (`lead_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_contacts_claim_idx` ON `lead_contacts` (`lead_id`,`kind`,`value`,`source_id`);--> statement-breakpoint
CREATE TABLE `lead_field_values` (
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
	CONSTRAINT "lead_field_values_field_check" CHECK("field" in ('name', 'legal_form', 'address', 'postal_code', 'city', 'municipality', 'classification', 'description', 'opening_hours', 'registration_number', 'tax_id', 'coordinates'))
);
--> statement-breakpoint
CREATE INDEX `lead_field_values_lead_idx` ON `lead_field_values` (`lead_id`,`field`);--> statement-breakpoint
CREATE INDEX `lead_field_values_current_idx` ON `lead_field_values` (`lead_id`,`is_current`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_field_values_claim_idx` ON `lead_field_values` (`lead_id`,`field`,`value`,`source_id`);--> statement-breakpoint
CREATE TABLE `lead_phones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`e164` text NOT NULL,
	`raw` text NOT NULL,
	`national_format` text,
	`type` text DEFAULT 'unknown' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`valid` integer DEFAULT true NOT NULL,
	`confidence` real,
	`source_id` text NOT NULL,
	`source_url` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lead_phones_type_check" CHECK("type" in ('mobile', 'landline', 'toll_free', 'voip', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX `lead_phones_e164_idx` ON `lead_phones` (`e164`);--> statement-breakpoint
CREATE INDEX `lead_phones_lead_idx` ON `lead_phones` (`lead_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_phones_claim_idx` ON `lead_phones` (`lead_id`,`e164`,`source_id`);--> statement-breakpoint
CREATE TABLE `lead_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_url` text NOT NULL,
	`raw_record_id` integer,
	`first_run_id` integer,
	`last_run_id` integer,
	`times_seen` integer DEFAULT 1 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_scraped_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_record_id`) REFERENCES `raw_records`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_sources_unique_idx` ON `lead_sources` (`lead_id`,`source_id`,`source_url`);--> statement-breakpoint
CREATE INDEX `lead_sources_lead_idx` ON `lead_sources` (`lead_id`);--> statement-breakpoint
CREATE INDEX `lead_sources_source_idx` ON `lead_sources` (`source_id`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`legal_form` text,
	`registration_number` text,
	`tax_id` text,
	`classification` text DEFAULT 'UNKNOWN' NOT NULL,
	`classification_confidence` real,
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
	`lead_score` integer DEFAULT 0 NOT NULL,
	`score_breakdown` text,
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
	CONSTRAINT "leads_classification_check" CHECK("classification" in ('FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE', 'BOTH', 'UNKNOWN')),
	CONSTRAINT "leads_status_check" CHECK("status" in ('new', 'reviewed', 'approved', 'rejected', 'merged'))
);
--> statement-breakpoint
CREATE INDEX `leads_name_city_idx` ON `leads` (`name_normalized`,`city_id`);--> statement-breakpoint
CREATE INDEX `leads_name_idx` ON `leads` (`name_normalized`);--> statement-breakpoint
CREATE INDEX `leads_registration_idx` ON `leads` (`registration_number`);--> statement-breakpoint
CREATE INDEX `leads_classification_status_idx` ON `leads` (`classification`,`status`,`lead_score`);--> statement-breakpoint
CREATE INDEX `leads_merged_into_idx` ON `leads` (`merged_into_id`);--> statement-breakpoint
CREATE INDEX `leads_last_scraped_idx` ON `leads` (`last_scraped_at`);--> statement-breakpoint
CREATE TABLE `merge_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`surviving_lead_id` integer NOT NULL,
	`merged_lead_id` integer NOT NULL,
	`signal` text NOT NULL,
	`signal_value` text NOT NULL,
	`score` real,
	`actor` text DEFAULT 'pipeline' NOT NULL,
	`run_id` integer,
	`snapshot` text NOT NULL,
	`merged_at` integer NOT NULL,
	`reverted_at` integer,
	`revert_note` text,
	FOREIGN KEY (`surviving_lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merge_log_signal_check" CHECK("signal" in ('phone', 'website_domain', 'email', 'registration_number', 'name_city', 'address', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `merge_log_surviving_idx` ON `merge_log` (`surviving_lead_id`);--> statement-breakpoint
CREATE INDEX `merge_log_merged_idx` ON `merge_log` (`merged_lead_id`);--> statement-breakpoint
CREATE INDEX `merge_log_merged_at_idx` ON `merge_log` (`merged_at`);--> statement-breakpoint
CREATE TABLE `raw_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`run_id` integer,
	`source_url` text NOT NULL,
	`content_hash` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`validation_error` text,
	`lead_id` integer,
	`seen_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "raw_records_status_check" CHECK("status" in ('pending', 'normalized', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_records_content_idx` ON `raw_records` (`source_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `raw_records_source_url_idx` ON `raw_records` (`source_id`,`source_url`);--> statement-breakpoint
CREATE INDEX `raw_records_run_idx` ON `raw_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `raw_records_status_idx` ON `raw_records` (`status`);--> statement-breakpoint
CREATE INDEX `raw_records_lead_idx` ON `raw_records` (`lead_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`category` text NOT NULL,
	`priority` text DEFAULT 'low' NOT NULL,
	`has_contractors` integer DEFAULT false NOT NULL,
	`has_stores` integer DEFAULT false NOT NULL,
	`requires_js` integer DEFAULT false NOT NULL,
	`robots_allows` integer,
	`robots_rule` text,
	`estimated_records` integer,
	`registry_files` text,
	`enabled` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sources_priority_check" CHECK("priority" in ('high', 'medium', 'low', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `sources_priority_idx` ON `sources` (`priority`,`enabled`);