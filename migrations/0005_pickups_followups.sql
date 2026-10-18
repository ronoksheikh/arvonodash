CREATE TABLE `pickups` (
	`id` text PRIMARY KEY NOT NULL,
	`business_date` text NOT NULL,
	`rider_name` text,
	`rider_phone` text,
	`ready_count` integer DEFAULT 0 NOT NULL,
	`handed_count` integer DEFAULT 0 NOT NULL,
	`left_behind_count` integer DEFAULT 0 NOT NULL,
	`note` text,
	`handed_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pickups_date_idx` ON `pickups` (`business_date`);--> statement-breakpoint
ALTER TABLE `consignments` ADD `follow_up_note` text;--> statement-breakpoint
ALTER TABLE `consignments` ADD `follow_up_at` text;--> statement-breakpoint
ALTER TABLE `consignments` ADD `follow_up_by` text;--> statement-breakpoint
ALTER TABLE `consignments` ADD `snoozed_until` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `pickup_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `handed_over_at` text;--> statement-breakpoint
CREATE INDEX `orders_pickup_idx` ON `orders` (`pickup_id`);