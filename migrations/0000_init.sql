CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`order_id` integer,
	`details` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_created_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_order_idx` ON `activity_log` (`order_id`);--> statement-breakpoint
CREATE TABLE `consignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`invoice` text NOT NULL,
	`consignment_id` text,
	`tracking_code` text,
	`status` text DEFAULT 'in_review' NOT NULL,
	`stage` text DEFAULT 'booked' NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_phone` text NOT NULL,
	`recipient_address` text NOT NULL,
	`cod_amount` real NOT NULL,
	`collected_amount` real,
	`delivery_charge` real,
	`note` text,
	`delivery_type` integer DEFAULT 0 NOT NULL,
	`line_items` text,
	`picked_up_at` text,
	`delivered_at` text,
	`returned_at` text,
	`last_status_at` text,
	`last_polled_at` text,
	`last_message` text,
	`is_final` integer DEFAULT false NOT NULL,
	`superseded` integer DEFAULT false NOT NULL,
	`payment_id` text,
	`settled_at` text,
	`created_by` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `consignments_invoice_unique` ON `consignments` (`invoice`);--> statement-breakpoint
CREATE UNIQUE INDEX `consignments_consignment_id_unique` ON `consignments` (`consignment_id`);--> statement-breakpoint
CREATE INDEX `consignments_order_idx` ON `consignments` (`order_id`);--> statement-breakpoint
CREATE INDEX `consignments_tracking_idx` ON `consignments` (`tracking_code`);--> statement-breakpoint
CREATE INDEX `consignments_final_idx` ON `consignments` (`is_final`);--> statement-breakpoint
CREATE INDEX `consignments_created_idx` ON `consignments` (`created_at`);--> statement-breakpoint
CREATE TABLE `custom_statuses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'gray' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`blocks_booking` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`phone` text NOT NULL,
	`name` text,
	`email` text,
	`shopify_customer_id` text,
	`note` text,
	`tags` text,
	`flag` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_unique` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `customers_shopify_idx` ON `customers` (`shopify_customer_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`key` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`run_after` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_key_unique` ON `jobs` (`key`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`customer_id` integer,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`rating` integer,
	`user_id` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notes_order_idx` ON `order_notes` (`order_id`);--> statement-breakpoint
CREATE INDEX `notes_customer_idx` ON `order_notes` (`customer_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shopify_id` text NOT NULL,
	`name` text NOT NULL,
	`order_number` integer,
	`shop_created_at` text NOT NULL,
	`shop_updated_at` text NOT NULL,
	`cancelled_at` text,
	`cancel_reason` text,
	`closed_at` text,
	`customer_id` integer,
	`shopify_customer_id` text,
	`customer_name` text,
	`phone` text,
	`raw_phone` text,
	`email` text,
	`address1` text,
	`address2` text,
	`city` text,
	`province` text,
	`zip` text,
	`country` text,
	`currency` text DEFAULT 'BDT' NOT NULL,
	`subtotal` real DEFAULT 0 NOT NULL,
	`shipping_total` real DEFAULT 0 NOT NULL,
	`discount_total` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`outstanding` real DEFAULT 0 NOT NULL,
	`financial_status` text,
	`shopify_fulfillment_status` text,
	`payment_gateways` text,
	`shipping_method` text,
	`line_items` text NOT NULL,
	`shopify_tags` text,
	`shopify_note` text,
	`note_attributes` text,
	`source_name` text,
	`status_id` integer,
	`internal_tags` text,
	`customer_remark` text,
	`risk_flags` text,
	`risk_dismissed` integer DEFAULT false NOT NULL,
	`duplicate_of_order_id` integer,
	`booking` text,
	`courier_stage` text DEFAULT 'unbooked' NOT NULL,
	`active_consignment_id` integer,
	`fulfillment_state` text DEFAULT 'none' NOT NULL,
	`fulfillment_error` text,
	`shopify_fulfillment_ids` text,
	`fulfilled_at` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_shopify_id_unique` ON `orders` (`shopify_id`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`shop_created_at`);--> statement-breakpoint
CREATE INDEX `orders_phone_idx` ON `orders` (`phone`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_stage_idx` ON `orders` (`courier_stage`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status_id`);--> statement-breakpoint
CREATE INDEX `orders_name_idx` ON `orders` (`name`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`amount` real,
	`status` text,
	`consignment_count` integer,
	`raw` text,
	`paid_at` text,
	`details_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`consignment_row_id` integer,
	`type` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'expected' NOT NULL,
	`steadfast_return_id` text,
	`steadfast_return_status` text,
	`condition` text,
	`restock_confirmed` integer DEFAULT false NOT NULL,
	`refund_confirmed` integer DEFAULT false NOT NULL,
	`follow_up_action` text,
	`follow_up_at` text,
	`notes` text,
	`created_by` integer,
	`received_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `returns_order_idx` ON `returns` (`order_id`);--> statement-breakpoint
CREATE INDEX `returns_status_idx` ON `returns` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`ip` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`stats` text,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_started_idx` ON `sync_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `tracking_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`consignment_row_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text,
	`message` text,
	`source` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tracking_consignment_idx` ON `tracking_events` (`consignment_row_id`);--> statement-breakpoint
CREATE INDEX `tracking_order_idx` ON `tracking_events` (`order_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'operator' NOT NULL,
	`permissions` text,
	`active` integer DEFAULT true NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`topic` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`payload` text NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_provider_ext_idx` ON `webhook_events` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `webhook_status_idx` ON `webhook_events` (`status`);--> statement-breakpoint
CREATE INDEX `webhook_received_idx` ON `webhook_events` (`received_at`);