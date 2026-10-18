# TASKS — ARVONO Fulfillment OS

Status legend: [x] done · [~] partial / limited by API · [ ] not started

## Research
- [x] Shopify GraphQL Admin API 2026-10: client-credentials auth, scopes, orders query, fulfillment orders, `fulfillmentCreate`, `tagsAdd`, webhook subscriptions, HMAC verification, throttling
- [x] Steadfast (Packzy) API: create/bulk order, status by cid/invoice/tracking, balance, return requests, payments, statuses, webhook (bearer token, payload, notification types)
- [x] Cloudflare Workers static assets + D1 + Drizzle + Cron limits
- [x] Notes written to `docs/API_NOTES.md` (incl. unsupported operations)

## Platform
- [x] Single Worker: Hono API + webhooks + static React build (SPA fallback)
- [x] D1 schema + migration (`migrations/0000_init.sql`)
- [x] Secrets via `wrangler secret`, never sent to the browser
- [x] Auth: owner setup, login, sessions, rate limiting, CSRF header, roles + per-user permissions
- [x] Cron every 5 min: jobs, webhook retry, courier polling, import continuation, hourly Shopify reconcile, 3-hourly payouts, daily pruning
- [x] D1 outbox (`jobs`) with backoff instead of Queues

## Shopify
- [x] Webhooks orders/create|updated|cancelled|delete with HMAC + dedupe + out-of-order protection
- [x] Resumable historical import (cursor pagination)
- [x] Reconciliation of missed webhooks (updated_at watermark)
- [x] Register webhooks + connection test from Settings
- [x] Auto-fulfillment with tracking, configurable trigger, partial (selected items), idempotent
- [x] Tag orders when booked (optional)
- [x] Respect orders fulfilled/cancelled directly in Shopify

## Orders
- [x] List with tabs + counts, search (incl. tracking/consignment/invoice), filters, sorting, pagination
- [x] Bulk: book, set status, add/remove tag, dismiss flags, archive, labels, slips, CSV
- [x] Detail drawer: customer, address, items, totals, payment, Shopify note/attributes/tags
- [x] Internal notes (typed), tags, customer remark, custom statuses (default + blocks-booking)
- [x] Duplicate / suspicious detection (phone validity, repeat orders, same items, address, history, flags, value, qty, test)
- [x] Booking editor with validation (Steadfast field limits)

## Steadfast
- [x] Manual booking only (single + bulk), duplicate prevention, unconfirmed-booking reconciliation
- [x] Webhooks (delivery_status, tracking_update) with bearer token, dedupe
- [x] Tracking timeline, stage mapping (booked / in transit / hold / delivered / partial / returned / cancelled / issue)
- [x] Manual refresh, manual status override, delivery notes, rider instructions
- [x] Return requests (Steadfast API) for delivered parcels
- [x] Redelivery via rebooking with new invoice (`-R1`)
- [~] Cancel consignment / redelivery request: not offered by the Steadfast API — flagged for staff to handle with Steadfast

## Customers & returns
- [x] Customer profiles by phone, history, success rate, flags (VIP/risky/blocked), notes, feedback, reviews with rating
- [x] Return records auto-created on return/partial delivery; status, condition, follow-ups, notes
- [x] Restock/refund are confirmation checkboxes only (no automatic refunds/restocks)

## COD & operations
- [x] COD booked/collected/in transit/awaiting payout/settled/lost; Steadfast balance
- [x] Payout sync matching consignments (defensive parsing — payout payload undocumented)
- [x] CSV export and packing slips (labels come from the external label service)
- [x] Activity log, sync history, webhook payload viewer, retry/cancel jobs, manual sync controls
- [x] Staff accounts & permissions

## UI
- [x] Mantine light/dark, responsive sidebar & mobile, drawers, modals, tabs, timelines, badges
- [x] Loading / empty / error states, real data only

## Testing
- [x] Unit tests (vitest): 22 passing
- [x] End-to-end suite against mock Shopify/Steadfast: 42 checks passing
- [x] Visual check (Playwright screenshots) light/dark/mobile, no console errors

## Order verification & dispatch (phase 2)
- [x] Calling status (Not called / No answer / Call again / Confirmed / Rejected) with notes, callback time, call history
- [x] Quick confirm from table, bulk calling actions, drawer verification panel
- [x] Confirmed → processing In progress, synced natively to Shopify (fulfillmentOrderReportProgress / fulfillmentOrderOpen)
- [x] Booking only for confirmed orders (still manual)
- [x] Cancel orders in Shopify (orderCancel, no refund) and delete-or-archive (orderDelete → orderClose fallback)
- [x] Two-way sync of Shopify admin/mobile edits (GraphQL re-read after webhooks, 15-min reconciliation)
- [x] Separate states: calling, processing, booking, label printing, dispatch
- [x] Label service API: printable, claim, printed, release, summary, mark-dispatched, jobs (API keys + scopes + idempotency)
- [x] Atomic claims, reservation expiry, late-confirmation safety, audited reprints, full history
- [x] Asia/Dhaka business dates, same-day and next-day (upTo) dispatch
- [x] Ready to print and Dispatch pages; API key management
- [x] D1 100-parameter / 100-column limits handled (json_each lists, trimmed joins)
- [x] e2e suite extended to 41 checks

## Deployment
- [x] Zero-config deploy: D1 auto-provisioned by `wrangler deploy`, migrations applied by the Worker at startup
- [x] Connections (Shopify, Steadfast) configured from Settings; Steadfast webhook token auto-generated; optional AES-GCM at rest
- [x] Webhook URLs derived from the serving domain

## Phase 3 — smart sync & high-volume workflow
- [x] Dashboard open/refresh pulls latest Shopify orders (throttled), then every minute while visible
- [x] Cron re-reads recent open orders (catches "Mark as in progress" from the Shopify app without a webhook)
- [x] Auto-booking timer after confirmation (default 10 min, configurable): countdown, cancel, book now, restart; flagged orders wait for review; claim is atomic (books once)
- [x] Customer history badge in the order list (new / returning ×N with success %)
- [x] Click-to-call phone links, one-click confirm in To call tab, new-order toast
- [x] Orders shipped before ARVONO: linked to their Steadfast parcel via Shopify tracking, or matched by order number on import; kept out of work queues
- [x] Work queues exclude orders already fulfilled in Shopify
- [x] e2e: 46 checks

## Scan & sort
- [x] Phone scanner page (/scan): camera barcode reading via WebAssembly ZXing (works on iOS Safari + Android), manual/hardware-scanner input
- [x] WebSocket scanning with HTTP fallback, offline queue + resend, beep/vibration per result
- [x] Scan = sorted (ready for pickup); dispatched only when Steadfast leaves in_review
- [x] Resolves consignment ID (primary), tracking code, invoice or order number; STOP on cancelled / old label
- [x] Scanning sessions with "still to sort" list; sorted >24h without pickup flagged as exception
- [x] e2e: WebSocket scan, duplicate, unknown, HTTP fallback, cancelled STOP

## Faster scanning + customer tracking
- [x] Scanner reads the camera 30×/s (guide-box crop, native BarcodeDetector when available, WASM otherwise); live reads/s badge
- [x] Laptop layout: camera in the middle, result and session panels on both sides that turn green / amber / red
- [x] Distinct sounds: success chime, duplicate double beep, failure buzzer
- [x] Camera picker, mirror toggle, scanner-gun input auto-focus
- [x] Customer tracking page `/t/<token>` with status, progress steps and full timeline (calls, sent to Steadfast, packed, picked up, courier updates, delivered/returned/cancelled)
- [x] Tracking token per order (backfilled by migration 0004), copy link in order drawer, `trackingUrl` in label API
- [x] e2e: 47 checks

## Same-day pickup, stuck parcels, owner report
- [x] Daily cut-off + pickup time settings; Pickup today page with countdowns and per-stage view of today's parcels (booking → label → scan → handed over → picked up)
- [x] Courier handover checklist: rider name/phone, scanned parcels only, left-behind and cancelled warnings, atomic (no double handover); Steadfast confirmation per handover
- [x] Stuck parcels: not confirmed after handover, on hold, no update N days, slower than district norm (learned p80, defaults for Dhaka/outside), not collected
- [x] Call customer / pickup rider / delivery rider (phone parsed from Steadfast updates); log call + snooze; note copied to the order
- [x] Owner report: orders & calls, courier flow, same-day rate, COD, worst districts/products for returns, calls per team member; printable
- [x] New permission `reports.view` (owner, admin, viewer)
- [x] e2e: 51 checks

## Fraud check, combined parcels, confirmed money
- [x] Steadfast fraud check (`/fraud_check/score`) per new order: cached per phone, per-minute budget, job queue; verdict good/watch/risky/new
- [x] Risky → `courier_fraud` flag, "Call first" tab, never auto-booked; fraud badge in list, fraud card in order drawer, re-check button
- [x] Steadfast lockout guard: 429 pauses all calls for Retry-After; 401 pauses until keys change; dashboard banner
- [x] `_approval_pending` → "Awaiting Steadfast confirmation"; money/returns/mark-paid only on confirmed status; `exceptional` in Stuck parcels
- [x] Partial delivery with only the delivery charge collected → "Delivery charge paid · product returned" + expected return
- [x] Mark COD orders paid in Shopify (`orderMarkAsPaid`) on confirmed delivery (skipped if collected < balance)
- [x] Combine same-customer orders into one parcel: order drawer, bulk "Send to Steadfast", auto-booking (waits for siblings); status/fulfillment/mark-paid per order; scanner STOP if a combined order is cancelled
- [x] Full tracking history (`/trackings_by_invoice`) fills gaps after missed webhooks, de-duplicated
- [x] Webhook: X-Signature verification; consignment_update, cancel_request, return_request, return_list_accepted, payment_request
- [x] Redesigned customer tracking page
- [x] e2e: 57 checks · unit: 36 tests

## Phase 5: lifecycle, SMS, branded tracking domain
- [x] Journey tab: every event from every source in one timeline + time between milestones
- [x] Ship-by date at booking (cut-off), automatic carry-over with count and history, undo handover, "rider has it, not confirmed"
- [x] Handover filled in automatically when Steadfast picks up; `picked_up_unscanned` logged; missed pickups on the owner report
- [x] Orders deleted in Shopify: webhook + 30-minute existence check; flagged until the parcel is stopped
- [x] Parcels deleted in Steadfast: `deleted` status instead of `cancelled → unknown`; finished parcels never regress from a poll
- [x] Customer SMS (sms.net.bd API, key as Worker secret, off by default): 7 moments, templates with placeholders, manual SMS, log, balance, test
- [x] Tracking page in ARVONO branding (Instrument Sans / Anek Bangla, logo), English + Bangla
- [x] Custom tracking domain (track.arvono.store): host-restricted, short links, domain check
- [x] e2e: 65 checks · unit: 56 tests

## Ideas / next
- [ ] Email the owner report daily (needs an email service — Cloudflare Email Routing could send to verified addresses)
- [ ] Shopify return creation (`returnCreate`) once the team wants returns mirrored in Shopify
- [ ] Per-zone delivery-charge estimates once Steadfast publishes a pricing endpoint
