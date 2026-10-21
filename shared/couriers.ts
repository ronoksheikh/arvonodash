// Courier companies the app can book with. Shared by the Worker and the app.

export const COURIERS = {
  steadfast: { label: "Steadfast", fullName: "Steadfast Courier" },
  carrybee: { label: "Carrybee", fullName: "Carrybee" },
} as const;
export type CourierId = keyof typeof COURIERS;
export const COURIER_IDS = Object.keys(COURIERS) as CourierId[];

export const courierName = (id: string | null | undefined) => COURIERS[(id ?? "steadfast") as CourierId]?.fullName ?? id ?? "Courier";

/**
 * Carrybee parcel statuses we store: the webhook event name without "order." (e.g. "picked"),
 * plus "cancelled" when we cancel it through the API. Labels for the dashboard.
 */
export const CARRYBEE_STATUSES: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  "pickup-requested": "Pickup requested",
  "assigned-for-pickup": "Assigned for pickup",
  "pickup-failed": "Pickup failed",
  "pickup-cancelled": "Pickup cancelled",
  cancelled: "Cancelled",
  picked: "Picked up",
  "at-the-sorting-hub": "At sorting hub",
  "on-the-way-to-central-warehouse": "To central warehouse",
  "at-central-warehouse": "At central warehouse",
  "in-transit": "In transit",
  "received-at-last-mile-hub": "At delivery hub",
  "assigned-for-delivery": "Out for delivery",
  "delivery-on-hold": "Delivery on hold",
  "delivery-failed": "Delivery attempt failed",
  delivered: "Delivered",
  "partial-delivery": "Partially delivered",
  "paid-return": "Returned (delivery charge paid)",
  exchange: "Exchanged",
  returned: "Returning",
  "returned-at-sorting": "Return at sorting hub",
  "returned-in-transit": "Return in transit",
  "returned-to-merchant": "Returned to us",
};
