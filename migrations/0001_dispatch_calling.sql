CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_by` integer,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `call_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`outcome` text NOT NULL,
	`note` text,
	`callback_at` text,
	`user_id` integer,
	`user_name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `call_logs_order_idx` ON `call_logs` (`order_id`);--> statement-breakpoint
CREATE TABLE `dispatch_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`consignment_row_id` integer,
	`event` text NOT NULL,
	`job_id` text,
	`actor` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dispatch_events_order_idx` ON `dispatch_events` (`order_id`);--> statement-breakpoint
CREATE INDEX `dispatch_events_job_idx` ON `dispatch_events` (`job_id`);--> statement-breakpoint
CREATE INDEX `dispatch_events_created_idx` ON `dispatch_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_scope_key_idx` ON `idempotency_keys` (`scope`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_created_idx` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `print_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`printed_count` integer DEFAULT 0 NOT NULL,
	`filters` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `print_jobs_created_idx` ON `print_jobs` (`created_at`);--> statement-breakpoint
ALTER TABLE `orders` ADD `calling_status` text DEFAULT 'not_called' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `call_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `last_call_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `callback_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `confirmed_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `confirmed_by` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `processing_status` text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `shopify_sync_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `shopify_sync_error` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `shopify_synced_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancel_requested_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `booked_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `booked_source` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `label_status` text DEFAULT 'not_ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `print_job_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `reserved_until` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `printed_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `print_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `dispatch_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `dispatched_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `dispatched_by` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `courier_received_at` text;--> statement-breakpoint
CREATE INDEX `orders_calling_idx` ON `orders` (`calling_status`);--> statement-breakpoint
CREATE INDEX `orders_label_idx` ON `orders` (`label_status`,`booked_at`);--> statement-breakpoint
CREATE INDEX `orders_print_job_idx` ON `orders` (`print_job_id`);--> statement-breakpoint
CREATE INDEX `orders_dispatch_idx` ON `orders` (`dispatch_status`,`booked_at`);--> statement-breakpoint
-- Backfill: orders booked before calling/dispatch tracking existed.
UPDATE `orders` SET `calling_status` = 'confirmed', `processing_status` = 'in_progress' WHERE `courier_stage` != 'unbooked';--> statement-breakpoint
UPDATE `orders` SET `booked_at` = (SELECT `created_at` FROM `consignments` WHERE `consignments`.`id` = `orders`.`active_consignment_id`) WHERE `active_consignment_id` IS NOT NULL;--> statement-breakpoint
UPDATE `orders` SET `label_status` = 'unprinted' WHERE `courier_stage` = 'booked' AND `cancelled_at` IS NULL;--> statement-breakpoint
UPDATE `orders` SET `label_status` = 'printed', `dispatch_status` = 'courier_received', `courier_received_at` = (SELECT `picked_up_at` FROM `consignments` WHERE `consignments`.`id` = `orders`.`active_consignment_id`) WHERE `courier_stage` NOT IN ('unbooked', 'booked', 'cancelled');
