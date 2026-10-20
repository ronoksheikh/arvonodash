-- Parcels deleted in the Steadfast portal before pickup were recorded as "unknown" (stage "issue",
-- not final) before the "deleted" status existed, so they still counted as COD with the courier.
-- Steadfast's "unknown" for a parcel it never picked up means it no longer exists.
INSERT INTO `tracking_events` (`consignment_row_id`, `order_id`, `kind`, `status`, `message`, `source`, `occurred_at`, `created_at`)
SELECT `id`, `order_id`, 'status', 'deleted', 'Parcel no longer exists in Steadfast (deleted in the portal before pickup)', 'system', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `consignments` WHERE `status` = 'unknown' AND `picked_up_at` IS NULL AND `consignment_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `orders` SET `courier_stage` = 'cancelled'
WHERE `active_consignment_id` IN (SELECT `id` FROM `consignments` WHERE `status` = 'unknown' AND `picked_up_at` IS NULL AND `consignment_id` IS NOT NULL)
  AND `courier_stage` IN ('issue', 'booked', 'awaiting_confirmation');
--> statement-breakpoint
UPDATE `consignments` SET `status` = 'deleted', `stage` = 'cancelled', `is_final` = 1, `collected_amount` = 0,
  `last_message` = 'Deleted in the Steadfast portal'
WHERE `status` = 'unknown' AND `picked_up_at` IS NULL AND `consignment_id` IS NOT NULL;
