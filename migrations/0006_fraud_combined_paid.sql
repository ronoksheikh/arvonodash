CREATE TABLE `fraud_checks` (
	`phone` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`delivery_ratio` real,
	`cancellation_ratio` real,
	`volume_band` text,
	`total_parcels` integer,
	`total_reports` integer DEFAULT 0 NOT NULL,
	`categories` text,
	`doubtful_reports` integer DEFAULT false NOT NULL,
	`score` real,
	`level` text,
	`verdict` text DEFAULT 'unknown' NOT NULL,
	`error` text,
	`raw` text,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `consignments` ADD `cod_changed_from` real;--> statement-breakpoint
ALTER TABLE `orders` ADD `combined_into_order_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `shopify_paid_at` text;--> statement-breakpoint
CREATE INDEX `orders_combined_idx` ON `orders` (`combined_into_order_id`);