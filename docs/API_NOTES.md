# API research notes

What this app relies on, where it comes from, and what is deliberately **not** used.
Researched October 2026.

## Shopify — GraphQL Admin API (version `2026-10`)

**Authentication**
- Dev Dashboard apps (the current way to build a single-store app) use the **client credentials grant**:
  `POST https://{shop}.myshopify.com/admin/oauth/access_token` with form fields
  `grant_type=client_credentials`, `client_id`, `client_secret`. Response: `access_token`, `scope`,
  `expires_in` (86399 s). Tokens expire after 24 h; we cache them in D1 and refresh 5 min early,
  and once more on a `401`.
- Works only when the app and the store belong to the same Shopify organization.
- Legacy admin-created custom apps with a static `shpat_…` token are also supported
  (`SHOPIFY_ACCESS_TOKEN`).
- Every call sends `X-Shopify-Access-Token`.

**Scopes required**
`read_orders`, `write_orders` (order tags), `read_customers`,
`read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`.
Optional: `read_all_orders` (import orders older than 60 days),
`read_assigned_fulfillment_orders` / `write_assigned_fulfillment_orders` and
`read_third_party_fulfillment_orders` / `write_third_party_fulfillment_orders`, if some orders are
assigned to app-managed locations.
Customer name, phone, email and address on orders are **protected customer data**: request
access for those fields in the Dev Dashboard. Without it, the API returns `null` for them.

**Operations used**
| Purpose | Operation |
|---|---|
| Import / reconcile orders | `orders(first, after, query, sortKey, reverse)`, with search `created_at:>=` or `updated_at:>=`, cursor pagination, 50 per page |
| Refresh one order | `order(id)` |
| Fulfill | `order.fulfillmentOrders` (status, `supportedActions`, line items with `remainingQuantity`) → `fulfillmentCreate(fulfillment: FulfillmentInput!)` with `lineItemsByFulfillmentOrder`, `trackingInfo {company, number, url}`, `notifyCustomer` |
| Tag booked orders | `tagsAdd(id, tags)` |
| Mark order "In progress" after phone confirmation | `fulfillmentOrderReportProgress(id, progressReport: {reasonNotes})` on each OPEN fulfillment order. Shopify then shows the fulfillment status **In progress** natively. No tags or notes are used |
| Undo "In progress" (confirmation withdrawn before booking) | `fulfillmentOrderOpen(id)` (2026-01+: reopens a progress-reported fulfillment order at a merchant-managed location) |
| Cancel fake/rejected orders | `orderCancel(orderId, reason: FRAUD\|CUSTOMER\|INVENTORY\|DECLINED\|STAFF\|OTHER, restock, notifyCustomer, staffNote, refundMethod: {originalPaymentMethodsRefund: false})`. It runs asynchronously; completion is confirmed by the `orders/cancelled` webhook or a GraphQL refresh. We never refund from here |
| Delete orders | `orderDelete(orderId)`. Only some order types can be deleted; when Shopify refuses, we fall back to `orderClose` (shown as **Archived** in Shopify admin) and archive locally |
| Health check | `shop { name currencyCode … }` |
| Webhooks | `webhookSubscriptions`, `webhookSubscriptionCreate(topic, webhookSubscription: {uri})` |

Customer contact fields come from `Customer.defaultPhoneNumber.phoneNumber` and
`defaultEmailAddress.emailAddress`. `Customer.phone` and `Customer.email` are deprecated.

**Two-way sync with Shopify admin and the mobile app**: every `orders/updated` webhook is upserted
from its REST payload. A GraphQL re-read job then follows, because REST `fulfillment_status`
cannot express "In progress", "On hold" and similar states. This picks up:
- an order marked In progress in Shopify, which we treat as phone-confirmed
- an order moved back to Unfulfilled, which goes back to *call again*
- cancellations, which remove the order from printing
- fulfillments made in Shopify
- phone or address edits after booking, which are flagged so Steadfast can be updated
- archive and delete

Reconciliation runs every 15 minutes as a backstop for missed webhooks.

Extra scope needs: `write_orders` covers cancel, close and delete. The app user also needs the
`delete_orders` permission to delete.

**Rate limits**: the query cost leaky bucket. We read `extensions.cost.throttleStatus`. On
`THROTTLED` we wait `(cost - available) / restoreRate`, back off when the bucket is below 10%,
and retry `429` / `5xx` with exponential backoff.

**Webhooks**
- Topics: `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_CANCELLED`, `ORDERS_DELETE`. The payload uses
  the REST order JSON shape.
- Verification: the base64 HMAC-SHA256 of the **raw body**, keyed with the app's client secret, is
  compared in constant time with `X-Shopify-Hmac-Sha256`.
- Deduplicate with `X-Shopify-Webhook-Id`. Respond within 5 s. Shopify retries 8 times over 4 h,
  then deletes the subscription. We therefore store the event and always return `200` once it is
  stored, then retry failed processing ourselves from D1.
- Webhooks can arrive out of order, so we ignore payloads whose `updated_at` is older than what we
  have stored.

## Steadfast Courier (Packzy) merchant API

Base URL `https://portal.packzy.com/api/v1`. Headers `Api-Key`, `Secret-Key`,
`Content-Type: application/json`. Source: Steadfast's published API document and their official
Laravel package (`steadfast-it/SteadFast-Courier-Laravel-Package`).

| Endpoint | Use |
|---|---|
| `POST /create_order` | Single booking. Fields: `invoice` (unique, alphanumeric/`-`/`_`), `recipient_name` (≤100), `recipient_phone` (11 digits), `alternative_phone`, `recipient_email`, `recipient_address` (≤250), `cod_amount` (≥0), `note`, `item_description`, `total_lot`, `delivery_type` (0 home, 1 point/hub) |
| `POST /create_order/bulk-order` | Up to 500, `data` = JSON-encoded array (client implemented; the UI books in parallel single calls for precise per-order errors) |
| `GET /status_by_cid/{id}`, `/status_by_invoice/{invoice}`, `/status_by_trackingcode/{code}` | `{ status, delivery_status }` |
| `GET /get_balance` | `{ current_balance }` |
| `POST /create_return_request` | `consignment_id` \| `invoice` \| `tracking_code`, `reason`. Statuses: pending, approved, processing, completed, cancelled |
| `GET /get_return_request/{id}`, `/get_return_requests` | Return requests |
| `GET /payments`, `/payments/{id}` | Payouts. **The response shape is not documented**, so it is parsed defensively (any `consignment_id` found in the details links a parcel) |

**Delivery statuses**: `in_review`, `pending`, `hold`, `delivered_approval_pending`,
`partial_delivered_approval_pending`, `cancelled_approval_pending`, `unknown_approval_pending`,
`delivered`, `partial_delivered`, `cancelled`, `unknown`.

**Webhook**: in the Steadfast panel you set a callback URL and an "Auth Token (Bearer)". Requests
carry `Authorization: Bearer <token>`. The documented payload fields are `consignment_id`,
`invoice`, `status`, `cod_amount`, `updated_at`. Newer deliveries add `notification_type`
(`delivery_status` | `tracking_update`), `delivery_charge` and `tracking_message`. A payload
without `notification_type` is treated as `delivery_status`. Other notification types are stored
and ignored. We reply `200 {"status":"success"}`.

**Not available through the API** (handled manually in the dashboard): cancelling a consignment,
requesting redelivery, editing a booked consignment. The dashboard handles these as follows:
- Redelivery is a rebooking with a new invoice (`#1001-R1`).
- A cancellation after booking is flagged for staff to call Steadfast.

**Deliberately not used**: endpoints that only appear in unofficial SDKs and are not in Steadfast's
own documentation, such as `fraud_check`, `trackings_by_invoice` and `create_pickup_request`. Risk
scoring uses our own delivery history instead.

Tracking links use `https://steadfast.com.bd/t/{tracking_code}`. You can change this with
`STEADFAST_TRACKING_URL`.

## Cloudflare

- One Worker serves the API, the webhooks and the static React build (Workers static assets,
  `run_worker_first` for `/api/*` and `/webhooks/*`, SPA fallback).
- D1 (SQLite) through Drizzle ORM. Migrations live in `migrations/` and are applied with
  `wrangler d1 migrations apply`.
- Cron trigger `*/5 * * * *`. A Workers Paid plan is recommended: CPU time for PBKDF2 login
  hashing, and more subrequests per invocation. Each cron step is capped (40 status polls, 25 jobs,
  ≤5 Shopify pages) to stay well inside the limits.
- **No Cloudflare Queues**: the background work is small and idempotent. A D1 outbox (`jobs` table)
  run via `waitUntil` plus the cron gives retries with backoff without extra infrastructure.
- Credentials are entered in Settings → Connections and stored server-side in D1, optionally
  AES-GCM encrypted with `APP_ENCRYPTION_KEY`. Worker secrets with the same names override them.
  The browser only ever sees masked hints.
- D1 is auto-provisioned on the first `wrangler deploy` (no `database_id` in config); the Worker
  applies pending migrations at startup using Wrangler's `d1_migrations` table.
