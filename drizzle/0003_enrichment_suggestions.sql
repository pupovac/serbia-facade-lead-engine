CREATE TABLE `enrichment_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`value_raw` text,
	`source_url` text NOT NULL,
	`origin` text NOT NULL,
	`confidence` real NOT NULL,
	`rule` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`run_id` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrichment_suggestions_kind_check" CHECK("kind" in ('email', 'website', 'facebook', 'instagram', 'google_maps', 'linkedin', 'youtube', 'other', 'phone', 'address', 'city')),
	CONSTRAINT "enrichment_suggestions_origin_check" CHECK("origin" in ('own_site', 'discovered')),
	CONSTRAINT "enrichment_suggestions_status_check" CHECK("status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrichment_suggestions_value_idx` ON `enrichment_suggestions` (`lead_id`,`kind`,`value`);--> statement-breakpoint
CREATE INDEX `enrichment_suggestions_status_idx` ON `enrichment_suggestions` (`status`,`confidence`);--> statement-breakpoint
CREATE INDEX `enrichment_suggestions_lead_idx` ON `enrichment_suggestions` (`lead_id`);