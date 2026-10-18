CREATE TABLE `sms_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`phone` text NOT NULL,
	`body` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_code` integer,
	`provider_message` text,
	`request_id` text,
	`segments` integer DEFAULT 1 NOT NULL,
	`sent_by` text NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE INDEX `sms_order_idx` ON `sms_messages` (`order_id`);--> statement-breakpoint
CREATE INDEX `sms_created_idx` ON `sms_messages` (`created_at`);--> statement-breakpoint
ALTER TABLE `orders` ADD `shopify_deleted_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `ship_by` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `carry_over_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `orders_ship_by_idx` ON `orders` (`ship_by`);--> statement-breakpoint
-- Parcels already booked but not yet picked up: due on their (Bangladesh) booking date.
UPDATE `orders` SET `ship_by` = date(datetime(`booked_at`, '+6 hours')) WHERE `booked_at` IS NOT NULL AND `dispatch_status` != 'dispatched' AND `combined_into_order_id` IS NULL;
