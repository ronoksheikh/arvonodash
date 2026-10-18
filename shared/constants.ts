// Shared between the Worker and the React app. Keep free of runtime dependencies.

export const PERMISSIONS = {
  "orders.view": "View orders and customers",
  "orders.edit": "Edit order notes, tags, statuses, booking details",
  "orders.call": "Record calls and confirm orders",
  "orders.cancel": "Cancel / delete orders in Shopify",
  "courier.book": "Send orders to Steadfast",
  "courier.manage": "Return requests, rebooking, status refresh",
  "fulfillment.manage": "Retry / trigger Shopify fulfillment",
  "returns.manage": "Manage returns",
  "cod.view": "View COD and settlements",
  "export": "Export CSV, print packing slips",
  "dispatch.manage": "Release print reservations, mark parcels dispatched",
  "labels.reprint": "Request label reprints",
  "sync.manage": "Run imports and manual syncs",
  "settings.manage": "Connection and workflow settings",
  "users.manage": "Staff accounts and permissions",
  "logs.view": "Activity logs and sync history",
  "reports.view": "Owner report (sales, returns, COD)",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLES = ["owner", "admin", "operator", "caller", "packer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== "users.manage"),
  operator: [
    "orders.view",
    "orders.edit",
    "orders.call",
    "dispatch.manage",
    "courier.book",
    "courier.manage",
    "fulfillment.manage",
    "returns.manage",
    "export",
    "logs.view",
  ],
  caller: ["orders.view", "orders.call"],
  packer: ["orders.view", "export", "dispatch.manage"],
  viewer: ["orders.view", "cod.view", "logs.view", "reports.view"],
};

// Courier stages derived from raw Steadfast statuses (see worker/services/steadfast.ts).
export const COURIER_STAGES = {
  unbooked: { label: "Not booked", color: "gray" },
  booked: { label: "Booked", color: "blue" },
  in_transit: { label: "In transit", color: "indigo" },
  on_hold: { label: "On hold", color: "yellow" },
  delivered: { label: "Delivered", color: "teal" },
  partial_delivered: { label: "Partial delivered", color: "lime" },
  returned: { label: "Returned", color: "red" },
  cancelled: { label: "Cancelled", color: "dark" },
  issue: { label: "Needs support", color: "orange" },
} as const;
export type CourierStage = keyof typeof COURIER_STAGES;

// Raw Steadfast delivery statuses (documented in the Steadfast API docs).
export const STEADFAST_STATUSES: Record<string, string> = {
  in_review: "In review",
  pending: "Pending (with courier)",
  hold: "On hold",
  delivered_approval_pending: "Delivered (approval pending)",
  partial_delivered_approval_pending: "Partial delivered (approval pending)",
  cancelled_approval_pending: "Cancelled (approval pending)",
  unknown_approval_pending: "Unknown (approval pending)",
  delivered: "Delivered",
  partial_delivered: "Partial delivered",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

export const FULFILLMENT_STATES = {
  none: { label: "Not fulfilled", color: "gray" },
  pending: { label: "Fulfillment queued", color: "blue" },
  fulfilled: { label: "Fulfilled", color: "teal" },
  failed: { label: "Fulfillment failed", color: "red" },
  skipped: { label: "Skipped", color: "gray" },
} as const;

export const FULFILLMENT_TRIGGERS = {
  on_pickup: "When Steadfast takes the parcel (status leaves in_review)",
  on_booking: "As soon as the consignment is created",
  on_delivery: "When the parcel is delivered",
  manual: "Manual only",
} as const;
export type FulfillmentTrigger = keyof typeof FULFILLMENT_TRIGGERS;

export const NOTE_KINDS = {
  internal: "Internal note",
  call_log: "Call log",
  customer_remark: "Customer remark",
  rider_instruction: "Rider instruction",
  delivery_note: "Delivery note",
  rider_feedback: "Rider / courier feedback",
  customer_review: "Customer review",
} as const;
export type NoteKind = keyof typeof NOTE_KINDS;

export const RETURN_STATUSES = {
  expected: { label: "Expected", color: "yellow" },
  in_transit: { label: "Coming back", color: "blue" },
  received: { label: "Received", color: "indigo" },
  inspected: { label: "Inspected", color: "teal" },
  closed: { label: "Closed", color: "gray" },
} as const;

export const RETURN_FOLLOW_UPS = {
  none: "No action",
  call_customer: "Call customer",
  redeliver: "Rebook / redeliver",
  exchange: "Exchange",
  refund: "Refund (confirm in Shopify)",
  block_customer: "Block customer",
} as const;

export const RISK_FLAGS: Record<string, string> = {
  invalid_phone: "Phone number is not a valid Bangladeshi mobile",
  duplicate_recent: "Same phone placed another order in the last 72 hours",
  duplicate_items: "Same phone ordered the same items recently",
  short_address: "Address looks incomplete",
  high_return_rate: "Customer has a high return/cancel history",
  blocked_customer: "Customer is blocked",
  risky_customer: "Customer is flagged as risky",
  high_value: "Unusually high COD value",
  test_order: "Looks like a test order",
  large_quantity: "Unusually large quantity",
  changed_after_booking: "Phone or address changed in Shopify after booking — update Steadfast",
};

export const CALLING_STATUSES = {
  not_called: { label: "Not called", color: "gray" },
  no_answer: { label: "No answer", color: "yellow" },
  call_again: { label: "Call again", color: "orange" },
  confirmed: { label: "Confirmed", color: "teal" },
  rejected: { label: "Rejected", color: "red" },
} as const;
export type CallingStatus = keyof typeof CALLING_STATUSES;

export const PROCESSING_STATUSES = {
  new: { label: "New", color: "gray" },
  in_progress: { label: "In progress", color: "blue" },
  cancelled: { label: "Cancelled", color: "dark" },
} as const;

export const LABEL_STATUSES = {
  not_ready: { label: "Not ready", color: "gray" },
  unprinted: { label: "Unprinted", color: "blue" },
  reserved: { label: "Reserved", color: "yellow" },
  printed: { label: "Printed", color: "teal" },
} as const;

export const DISPATCH_STATUSES = {
  pending: { label: "Not sorted", color: "gray" },
  sorted: { label: "Sorted · awaiting pickup", color: "indigo" },
  dispatched: { label: "Dispatched", color: "teal" },
} as const;

export const SHOPIFY_SYNC_STATUSES = {
  none: { label: "—", color: "gray" },
  pending: { label: "Syncing", color: "blue" },
  synced: { label: "In progress in Shopify", color: "teal" },
  failed: { label: "Shopify sync failed", color: "red" },
} as const;

export const DISPATCH_EVENTS: Record<string, string> = {
  label_ready: "Ready to print",
  reserved: "Reserved for printing",
  printed: "Label printed",
  released: "Reservation released",
  expired: "Reservation expired",
  reprint_requested: "Reprint requested",
  sorted: "Scanned & sorted",
  unsorted: "Sorting undone",
  handed_over: "Handed to courier rider",
  dispatched: "Dispatched (picked up by Steadfast)",
  dispatch_undone: "Dispatch undone",
  courier_received: "Received by courier",
};
