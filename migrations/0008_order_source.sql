ALTER TABLE `orders` ADD `channel` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `utm_source` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `utm_medium` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `utm_campaign` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `attribution` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `attribution_checked_at` text;--> statement-breakpoint
CREATE INDEX `orders_channel_idx` ON `orders` (`channel`,`shop_created_at`);--> statement-breakpoint
CREATE INDEX `orders_campaign_idx` ON `orders` (`utm_campaign`);--> statement-breakpoint
-- Orders made by staff or at a till need no journey to know where they came from.
UPDATE `orders` SET `channel` = CASE `source_name` WHEN 'shopify_draft_order' THEN 'draft_order' WHEN 'pos' THEN 'pos' END WHERE `source_name` IN ('shopify_draft_order', 'pos');
