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
- [x] CSV export, printable labels (Code128) and packing slips
- [x] Activity log, sync history, webhook payload viewer, retry/cancel jobs, manual sync controls
- [x] Staff accounts & permissions

## UI
- [x] Mantine light/dark, responsive sidebar & mobile, drawers, modals, tabs, timelines, badges
- [x] Loading / empty / error states, real data only

## Testing
- [x] Unit tests (vitest): 22 passing
- [x] End-to-end suite against mock Shopify/Steadfast: 28 checks passing
- [x] Visual check (Playwright screenshots) light/dark/mobile, no console errors

## Ideas / next
- [ ] SMS confirmation to customers (needs a BD SMS gateway — out of scope, no external services)
- [ ] Shopify return creation (`returnCreate`) once the team wants returns mirrored in Shopify
- [ ] Per-zone delivery-charge estimates once Steadfast publishes a pricing endpoint
