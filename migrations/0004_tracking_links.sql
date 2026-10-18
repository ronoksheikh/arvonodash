ALTER TABLE `orders` ADD `tracking_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_tracking_token_idx` ON `orders` (`tracking_token`);--> statement-breakpoint
-- Give every existing order a tracking link (80 random bits, hex).
UPDATE `orders` SET `tracking_token` = lower(hex(randomblob(10))) WHERE `tracking_token` IS NULL;
