import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// All timestamps are ISO-8601 UTC strings. Money is stored as REAL in BDT (store currency).

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("operator"), // owner | admin | operator | viewer
  permissions: text("permissions", { mode: "json" }).$type<string[]>(), // overrides role defaults when set
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // SHA-256 of the session token
    userId: integer("user_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(), // email or ip
  count: integer("count").notNull().default(0),
  windowStart: text("window_start").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
  updatedAt: text("updated_at").notNull(),
});

export const customers = sqliteTable(
  "customers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    phone: text("phone").notNull().unique(), // normalized 01XXXXXXXXX
    name: text("name"),
    email: text("email"),
    shopifyCustomerId: text("shopify_customer_id"),
    note: text("note"),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    flag: text("flag"), // null | vip | risky | blocked
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("customers_shopify_idx").on(t.shopifyCustomerId)],
);

export type LineItem = {
  id: string; // numeric Shopify line item id
  title: string;
  variantTitle?: string | null;
  sku?: string | null;
  quantity: number;
  fulfillableQuantity?: number | null;
  price: number;
  productId?: string | null;
  variantId?: string | null;
};

export type BookingDetails = {
  recipientName: string;
  recipientPhone: string;
  alternativePhone?: string;
  recipientEmail?: string;
  recipientAddress: string;
  codAmount: number;
  note?: string;
  itemDescription?: string;
  totalLot?: number;
  deliveryType: 0 | 1; // 0 home delivery, 1 point delivery / hub pickup
  lineItems?: { lineItemId: string; quantity: number }[]; // empty/undefined = whole order
};

export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    shopifyId: text("shopify_id").notNull().unique(), // numeric id
    name: text("name").notNull(), // "#1001"
    orderNumber: integer("order_number"),
    shopCreatedAt: text("shop_created_at").notNull(),
    shopUpdatedAt: text("shop_updated_at").notNull(),
    cancelledAt: text("cancelled_at"),
    cancelReason: text("cancel_reason"),
    closedAt: text("closed_at"),
    customerId: integer("customer_id"),
    shopifyCustomerId: text("shopify_customer_id"),
    customerName: text("customer_name"),
    phone: text("phone"), // normalized
    rawPhone: text("raw_phone"),
    email: text("email"),
    address1: text("address1"),
    address2: text("address2"),
    city: text("city"),
    province: text("province"),
    zip: text("zip"),
    country: text("country"),
    currency: text("currency").notNull().default("BDT"),
    subtotal: real("subtotal").notNull().default(0),
    shippingTotal: real("shipping_total").notNull().default(0),
    discountTotal: real("discount_total").notNull().default(0),
    total: real("total").notNull().default(0),
    outstanding: real("outstanding").notNull().default(0),
    financialStatus: text("financial_status"), // shopify display financial status (lowercase)
    shopifyFulfillmentStatus: text("shopify_fulfillment_status"), // unfulfilled | partial | fulfilled | ...
    paymentGateways: text("payment_gateways", { mode: "json" }).$type<string[]>(),
    shippingMethod: text("shipping_method"),
    lineItems: text("line_items", { mode: "json" }).$type<LineItem[]>().notNull(),
    shopifyTags: text("shopify_tags", { mode: "json" }).$type<string[]>(),
    shopifyNote: text("shopify_note"),
    noteAttributes: text("note_attributes", { mode: "json" }).$type<{ name: string; value: string }[]>(),
    sourceName: text("source_name"),
    // Internal workflow
    statusId: integer("status_id"), // custom status
    internalTags: text("internal_tags", { mode: "json" }).$type<string[]>(),
    customerRemark: text("customer_remark"),
    riskFlags: text("risk_flags", { mode: "json" }).$type<string[]>(),
    riskDismissed: integer("risk_dismissed", { mode: "boolean" }).notNull().default(false),
    duplicateOfOrderId: integer("duplicate_of_order_id"),
    booking: text("booking", { mode: "json" }).$type<Partial<BookingDetails>>(), // saved edits before submission
    // Calling / verification
    callingStatus: text("calling_status").notNull().default("not_called"), // not_called | no_answer | confirmed | rejected | call_again
    callAttempts: integer("call_attempts").notNull().default(0),
    lastCallAt: text("last_call_at"),
    callbackAt: text("callback_at"),
    confirmedAt: text("confirmed_at"),
    confirmedBy: integer("confirmed_by"),
    processingStatus: text("processing_status").notNull().default("new"), // new | in_progress | cancelled
    shopifySyncStatus: text("shopify_sync_status").notNull().default("none"), // none | pending | synced | failed
    shopifySyncError: text("shopify_sync_error"),
    shopifySyncedAt: text("shopify_synced_at"),
    cancelRequestedAt: text("cancel_requested_at"),
    // Label printing (external label service) and physical dispatch
    bookedAt: text("booked_at"),
    bookedSource: text("booked_source"), // Shopify phone|address at booking time
    labelStatus: text("label_status").notNull().default("not_ready"), // not_ready | unprinted | reserved | printed
    printJobId: text("print_job_id"),
    reservedUntil: text("reserved_until"),
    printedAt: text("printed_at"),
    printCount: integer("print_count").notNull().default(0),
    dispatchStatus: text("dispatch_status").notNull().default("pending"), // pending | dispatched | courier_received
    dispatchedAt: text("dispatched_at"),
    dispatchedBy: text("dispatched_by"),
    courierReceivedAt: text("courier_received_at"),
    // Courier & fulfillment (kept separate)
    courierStage: text("courier_stage").notNull().default("unbooked"), // unbooked|booked|in_transit|on_hold|delivered|partial_delivered|returned|cancelled|issue
    activeConsignmentId: integer("active_consignment_id"),
    fulfillmentState: text("fulfillment_state").notNull().default("none"), // none|pending|fulfilled|failed|skipped
    fulfillmentError: text("fulfillment_error"),
    shopifyFulfillmentIds: text("shopify_fulfillment_ids", { mode: "json" }).$type<string[]>(),
    fulfilledAt: text("fulfilled_at"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("orders_created_idx").on(t.shopCreatedAt),
    index("orders_phone_idx").on(t.phone),
    index("orders_customer_idx").on(t.customerId),
    index("orders_stage_idx").on(t.courierStage),
    index("orders_status_idx").on(t.statusId),
    index("orders_name_idx").on(t.name),
    index("orders_calling_idx").on(t.callingStatus),
    index("orders_label_idx").on(t.labelStatus, t.bookedAt),
    index("orders_print_job_idx").on(t.printJobId),
    index("orders_dispatch_idx").on(t.dispatchStatus, t.bookedAt),
  ],
);

export const consignments = sqliteTable(
  "consignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    invoice: text("invoice").notNull().unique(),
    consignmentId: text("consignment_id").unique(), // Steadfast id
    trackingCode: text("tracking_code"),
    status: text("status").notNull().default("in_review"), // raw Steadfast status
    stage: text("stage").notNull().default("booked"),
    recipientName: text("recipient_name").notNull(),
    recipientPhone: text("recipient_phone").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    codAmount: real("cod_amount").notNull(),
    collectedAmount: real("collected_amount"), // reported by webhook on delivery
    deliveryCharge: real("delivery_charge"),
    note: text("note"),
    deliveryType: integer("delivery_type").notNull().default(0),
    lineItems: text("line_items", { mode: "json" }).$type<{ lineItemId: string; quantity: number }[]>(),
    pickedUpAt: text("picked_up_at"),
    deliveredAt: text("delivered_at"),
    returnedAt: text("returned_at"),
    lastStatusAt: text("last_status_at"),
    lastPolledAt: text("last_polled_at"),
    lastMessage: text("last_message"),
    isFinal: integer("is_final", { mode: "boolean" }).notNull().default(false),
    superseded: integer("superseded", { mode: "boolean" }).notNull().default(false), // replaced by a rebooking
    paymentId: text("payment_id"),
    settledAt: text("settled_at"),
    createdBy: integer("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("consignments_order_idx").on(t.orderId),
    index("consignments_tracking_idx").on(t.trackingCode),
    index("consignments_final_idx").on(t.isFinal),
    index("consignments_created_idx").on(t.createdAt),
  ],
);

export const trackingEvents = sqliteTable(
  "tracking_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    consignmentRowId: integer("consignment_row_id").notNull(),
    orderId: integer("order_id").notNull(),
    kind: text("kind").notNull(), // status | tracking | system
    status: text("status"),
    message: text("message"),
    source: text("source").notNull(), // webhook | poll | manual | api
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("tracking_consignment_idx").on(t.consignmentRowId), index("tracking_order_idx").on(t.orderId)],
);

export const orderNotes = sqliteTable(
  "order_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id"),
    customerId: integer("customer_id"),
    kind: text("kind").notNull(), // internal | customer_remark | rider_instruction | delivery_note | rider_feedback | customer_review | call_log
    body: text("body").notNull(),
    rating: integer("rating"), // 1..5 for reviews
    userId: integer("user_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("notes_order_idx").on(t.orderId), index("notes_customer_idx").on(t.customerId)],
);

export const customStatuses = sqliteTable("custom_statuses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  color: text("color").notNull().default("gray"),
  sortOrder: integer("sort_order").notNull().default(0),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  blocksBooking: integer("blocks_booking", { mode: "boolean" }).notNull().default(false),
});

export const returns = sqliteTable(
  "returns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    consignmentRowId: integer("consignment_row_id"),
    type: text("type").notNull(), // courier_return (failed delivery) | partial_return | customer_return (after delivery)
    reason: text("reason"),
    status: text("status").notNull().default("expected"), // expected | in_transit | received | inspected | closed
    steadfastReturnId: text("steadfast_return_id"),
    steadfastReturnStatus: text("steadfast_return_status"),
    condition: text("condition"), // good | damaged | missing_items
    restockConfirmed: integer("restock_confirmed", { mode: "boolean" }).notNull().default(false),
    refundConfirmed: integer("refund_confirmed", { mode: "boolean" }).notNull().default(false),
    followUpAction: text("follow_up_action"), // none | redeliver | call_customer | block_customer | refund | exchange
    followUpAt: text("follow_up_at"),
    notes: text("notes"),
    createdBy: integer("created_by"),
    receivedAt: text("received_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("returns_order_idx").on(t.orderId), index("returns_status_idx").on(t.status)],
);

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(), // Steadfast payment id
  amount: real("amount"),
  status: text("status"),
  consignmentCount: integer("consignment_count"),
  raw: text("raw", { mode: "json" }),
  paidAt: text("paid_at"),
  detailsSyncedAt: text("details_synced_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id"),
    actor: text("actor").notNull(), // user name, "system", "shopify", "steadfast"
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    orderId: integer("order_id"),
    details: text("details", { mode: "json" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("activity_created_idx").on(t.createdAt), index("activity_order_idx").on(t.orderId)],
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(), // shopify | steadfast
    externalId: text("external_id").notNull(),
    topic: text("topic").notNull(),
    status: text("status").notNull().default("received"), // received | processed | failed | ignored
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    payload: text("payload").notNull(),
    receivedAt: text("received_at").notNull(),
    processedAt: text("processed_at"),
  },
  (t) => [
    uniqueIndex("webhook_provider_ext_idx").on(t.provider, t.externalId),
    index("webhook_status_idx").on(t.status),
    index("webhook_received_idx").on(t.receivedAt),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(), // fulfill_order | shopify_tag
    key: text("key").notNull().unique(), // idempotency key
    payload: text("payload", { mode: "json" }),
    status: text("status").notNull().default("pending"), // pending | running | done | failed | cancelled
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    runAfter: text("run_after").notNull(),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("jobs_status_idx").on(t.status, t.runAfter)],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(), // shopify_import | shopify_reconcile | courier_poll | payments | jobs
    trigger: text("trigger").notNull(), // cron | manual
    status: text("status").notNull().default("running"), // running | success | partial | failed
    stats: text("stats", { mode: "json" }),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("sync_runs_started_idx").on(t.startedAt)],
);

export const callLogs = sqliteTable(
  "call_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    outcome: text("outcome").notNull(), // calling status recorded by this call
    note: text("note"),
    callbackAt: text("callback_at"),
    userId: integer("user_id"),
    userName: text("user_name"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("call_logs_order_idx").on(t.orderId)],
);

/** Keys for external services (e.g. the label printing service). Only a SHA-256 hash is stored. */
export const apiKeys = sqliteTable("api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  createdBy: integer("created_by"),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
});

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(), // api key id or user id
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("processing"), // processing | done
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idempotency_scope_key_idx").on(t.scope, t.key), index("idempotency_created_idx").on(t.createdAt)],
);

export const printJobs = sqliteTable(
  "print_jobs",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(), // api key name or user name
    status: text("status").notNull().default("reserved"), // reserved | completed | partial | released | expired
    orderCount: integer("order_count").notNull().default(0),
    printedCount: integer("printed_count").notNull().default(0),
    filters: text("filters", { mode: "json" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [index("print_jobs_created_idx").on(t.createdAt)],
);

/** Full label printing and dispatch history per order. */
export const dispatchEvents = sqliteTable(
  "dispatch_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    consignmentRowId: integer("consignment_row_id"),
    event: text("event").notNull(), // label_ready | reserved | printed | released | expired | reprint_requested | dispatched | dispatch_undone | courier_received
    jobId: text("job_id"),
    actor: text("actor").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("dispatch_events_order_idx").on(t.orderId), index("dispatch_events_job_idx").on(t.jobId), index("dispatch_events_created_idx").on(t.createdAt)],
);
