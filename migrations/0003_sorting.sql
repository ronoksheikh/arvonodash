CREATE TABLE `sort_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`started_by` text NOT NULL,
	`started_at` text NOT NULL,
	`closed_at` text,
	`scanned_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sort_batches_started_idx` ON `sort_batches` (`started_at`);--> statement-breakpoint
ALTER TABLE `orders` ADD `sorted_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `sorted_by` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `sort_batch_id` text;--> statement-breakpoint
-- Old meaning: dispatched = staff handover, courier_received = Steadfast pickup.
-- New meaning: sorted = label scanned at packing, dispatched = Steadfast pickup.
UPDATE `orders` SET `sorted_at` = `dispatched_at`, `sorted_by` = `dispatched_by`, `dispatch_status` = 'sorted' WHERE `dispatch_status` = 'dispatched';--> statement-breakpoint
UPDATE `orders` SET `dispatch_status` = 'dispatched', `dispatched_at` = `courier_received_at` WHERE `dispatch_status` = 'courier_received';
