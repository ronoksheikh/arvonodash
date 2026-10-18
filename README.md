# ARVONO Fulfillment OS

An internal operations dashboard for a Shopify store that ships cash-on-delivery orders in
Bangladesh with **Steadfast Courier**. Shopify webhooks sync orders into the dashboard. Staff
review them and **manually** book them with Steadfast. Courier webhooks then track the parcels,
and the Shopify order is fulfilled automatically with tracking once the courier has the parcel.

Everything runs on Cloudflare: a single Worker serves the API, the webhooks and the React app, D1
is the database, and a Cron Trigger handles recovery.

```
Shopify ──webhooks──► Worker (Hono) ◄──webhooks── Steadfast
   ▲                      │  D1 (Drizzle)              ▲
   └── GraphQL Admin API ─┤  Cron */5 min ─────────────┘ status polling, payouts
                          └─ React + Mantine dashboard (static assets)
```

## Daily workflow

```
New order → Call customer → Confirmed (Shopify: In progress) → Admin books Steadfast → Ready to print
→ Label service prints & confirms → Printed → Dispatched (staff) → Steadfast confirms pickup
→ Shopify fulfilled (tracking added) → Delivered / Returned
```

Everything is synchronised automatically except the **calling confirmation** and **physical
dispatch**. Booking happens automatically a few minutes after confirmation (default 10, set in
Settings → Workflow); staff can cancel the timer or book immediately. Flagged orders always wait
for a human.

Each order keeps five separate states: calling, processing, Steadfast booking, label printing and
dispatch. Shopify fulfillment and courier delivery are tracked on top of these.

## Features

- **Overview**: today's orders and revenue, the booking/transit/delivered/returned pipeline,
  delivery success rate, COD booked/collected/settled, an orders-per-day chart, orders needing
  attention, and recent activity. All figures are real data.
- **Orders**: real-time webhook sync and a resumable historical import. Search by order, name,
  phone, address, tracking code or consignment ID. Filter by tab, custom status, date range,
  flags and tags; sort; select in bulk. The order drawer shows the customer, address, items,
  payment, Shopify notes and attributes, internal status, tags and customer remark.
- **Duplicate and fraud signals**:
  - an invalid BD mobile number
  - the same phone ordering again within N hours, or ordering the same items again
  - an incomplete address
  - a customer with a high return rate, or one flagged risky or blocked
  - a high COD value, a large quantity, or a test order
- **Calling & verification**: Not called / No answer / Call again / Confirmed / Rejected. Set
  these from the order table (one-click confirm) or the order drawer, with call notes, callback
  time and full call history.
  - Confirming moves the order to *In progress*, natively in Shopify
    (`fulfillmentOrderReportProgress`), and makes it bookable.
  - Rejected orders can be cancelled in Shopify (`orderCancel`, never refunds) or
    deleted/archived where Shopify allows it.
- **Two-way Shopify sync**: changes made in the Shopify admin or mobile app sync back to this
  dashboard. These include In progress, cancellations, fulfillments, address and phone edits
  (flagged when the order is already booked), and archive/delete.
- **Ready to print**: per-day (Asia/Dhaka) unprinted, reserved and printed lists, daily totals, the
  next-day backlog, print job history, release, and audited reprint requests.
- **Scan & sort (laptop or phone)**: open `/scan` on a MacBook, iPhone Safari or Android Chrome,
  scan the Steadfast consignment ID barcode on each label, and hear the result. The camera is
  read 30 times a second (the browser's built-in barcode reader on Chrome, WebAssembly
  elsewhere). The camera sits in the middle with a status panel on each side. Both panels turn
  green with a rising chime when a parcel is sorted, amber with a double beep when it was already
  sorted, and red with a low buzzer for any problem. A USB or Bluetooth scanner gun also works,
  and you can switch cameras (including an iPhone used as a Mac webcam). Each parcel becomes
  *Sorted · awaiting pickup*. Scans go over a live WebSocket, are queued offline and resent
  automatically, and a cancelled order gives a loud STOP. It becomes *Dispatched* only when
  Steadfast picks it up (status leaves in_review).
- **Customer tracking page** (`/t/<token>`): every order gets its own unguessable link, copied
  from the order drawer. The customer sees the current status, a progress bar, and every step:
  placed, the confirmation calls (including missed calls), sent to Steadfast, packed, picked up,
  courier updates, delivered, returned or cancelled. It also shows the items, totals, COD due and
  delivery address. The phone number is masked and no staff names or internal notes are shown.
  The label API returns the link as `trackingUrl` for printing as a QR code. SMS is not sent yet.
- **Steadfast fraud check** on every new order: the customer's delivery record across all
  Steadfast merchants (delivered %, cancelled %, volume, merchant fraud reports), shown as a badge
  in the order list and a card on the order.
  - Risky customers (below 70% delivered, or any merchant report; adjustable) go to **Call first**
    and are never auto-booked; staff can still send them after calling.
  - Each phone is looked up at most once per 24 h, capped per minute. Any 429 pauses all Steadfast
    calls, so the account is never locked out.
- **One parcel per customer**: when the same phone has several confirmed orders, they can go out
  as one Steadfast parcel, from the order, from bulk "Send to Steadfast", or automatically
  (auto-booking waits for the last timer).
  - The parcel's COD is the sum of the orders, there is one label and one scan, and every order
    follows the parcel's status.
  - Each order is fulfilled and marked paid in Shopify on its own.
- **Money only when Steadfast confirms**: "delivered (approval pending)" is shown as *Awaiting
  Steadfast confirmation*.
  - On confirmed delivery the COD order is **marked paid in Shopify**, so Shopify's sales reports
    are right.
  - A partial delivery where only the delivery charge was collected is shown as *Delivery charge
    paid · product returned*, and a return is expected.
- **Steadfast webhooks**: the signature is verified. Portal edits (address or COD), cancel and
  return requests, return lists and payouts are applied instantly. Missed steps are filled from
  Steadfast's full tracking history.
- **Pickup today** (`/pickup`): orders confirmed before the daily cut-off (default 4:00 PM, set
  in Settings) ship the same day.
  - Live countdowns to the cut-off and to the usual courier pickup time.
  - Each parcel shows where it is: not booked → label not printed → not scanned → ready
    (scanned) → handed to rider → picked up by Steadfast. Parcels carried over from earlier days
    are marked.
  - **Courier arrived → hand over**: record the rider's name and phone and tick the scanned
    parcels they take. Unscanned parcels are listed as *left behind*, and scanned parcels that
    were cancelled in Shopify get a "do NOT give" warning.
  - Each handover shows how many parcels Steadfast has confirmed picking up.
  - Handing over never marks a parcel dispatched; only Steadfast's own status does that.
- **Stuck parcels** (`/stuck`, with a badge in the menu) lists parcels that need a call:
  - handed to the rider, but Steadfast hasn't confirmed pickup after 12 h
  - on hold
  - no Steadfast update for 3+ days
  - slower than normal for the district (learned from your own deliveries, with defaults until
    there is enough history)
  - scanned more than a day ago but never collected

  Each card has buttons to call the customer, the pickup rider (from the handover) and the
  delivery rider (when Steadfast's updates include their number). You can also log the call with
  quick notes, which are added to the order notes, and snooze the parcel for 1–3 days.
- **Owner report** (`/report`): today, yesterday, last 7 or 30 days, or a custom range.
  - Orders received, confirm rate, rejected, cancelled, still to call, new customers.
  - Sent to Steadfast, picked up, delivered, returned, delivery success rate.
  - Same-day dispatch rate against the cut-off.
  - COD collected, delivery charges, paid out by Steadfast, awaiting payout, COD with the courier.
  - The worst districts and products for returns, and calls per team member.
  - Printable. It is an on-screen report only; there is no email (that needs an email service).
- **Dispatch**: to sort, sorted (awaiting pickup), dispatched, and exceptions
  (held, failed, returned, cancelled after booking, dispatched more than 24 h ago without a
  pickup). Includes bulk *Mark dispatched* and *Undo* with a reason.
- **Label service API** (`/api/v1/dispatch/*`, see [docs/DISPATCH_API.md](docs/DISPATCH_API.md)):
  - API keys with scopes
  - mandatory idempotency keys
  - atomic claims, so concurrent print processes never get the same order
  - printed only on explicit confirmation
  - expiring reservations, safe late confirmations, and full print/dispatch history
- **Booking editor**: edit the recipient, phone, alternative phone, address (250-character
  limit), COD, delivery type (home or point), item description, lot and rider note before
  booking. You can also ship only some items, which gives a partial fulfillment.
- **Manual booking only, for confirmed orders**: orders are sent to Steadfast only when a staff member clicks *Book*,
  one at a time or in bulk. Imports and webhooks never book. Duplicates are blocked by an
  active-consignment check plus a unique invoice, enforced in D1 and by Steadfast. Custom
  statuses such as *Hold* or *Fake* can block booking.
- **Consignments**: consignment ID and tracking code, the full tracking timeline (webhook, poll
  and manual entries), a stuck-parcel filter, manual refresh, a manual status override with an
  audit trail, delivery notes, Steadfast return requests, and rebooking for redelivery.
- **Automatic Shopify fulfillment**: configurable to fire on pickup (default), on booking, on
  delivery, or manually. It uses `fulfillmentCreate` on the open fulfillment orders, with
  Steadfast tracking number and URL. It is idempotent and never fulfills an item twice. Failures
  are retried with backoff and shown in the dashboard. Shopify fulfillment status is kept
  separate from courier delivery status.
- **Returns**: a return record is created automatically when Steadfast cancels a parcel after
  pickup or delivers it partially. Each return tracks status, condition, reason, follow-up action
  and date, and notes. Restock and refund are **staff confirmations only**: nothing is refunded or
  restocked automatically.
- **Customers**: grouped by phone number, with order history, delivered/returned counts, success
  rate, VIP/risky/blocked flags, notes, call logs, rider feedback and customer reviews with
  ratings.
- **COD & settlements**: COD booked, collected, with the courier, awaiting payout and settled,
  plus the Steadfast balance, payouts matched to parcels, and delivered parcels not yet paid out.
- **Operations**: CSV export (filtered or selected), A5 packing slips (shipping labels come from
  the external label service), staff accounts with roles and per-permission overrides, an
  activity log, a sync history with webhook payload inspection, retry controls, and connection
  tests.
- **UI**: Mantine with light and dark mode, a responsive sidebar and mobile layout, drawers,
  tabs, timelines, and loading, empty and error states.

## Project layout

```
worker/            Cloudflare Worker (Hono)
  index.ts         routes + cron handler
  routes/          auth, webhooks, orders, consignments, misc (dashboard/customers/returns/COD), admin
  services/        shopify, steadfast, courier (booking + status engine), fulfillment, jobs, sync, orders
  db/schema.ts     Drizzle schema
src/               React app (Vite + Mantine)
shared/            constants shared by Worker and UI (statuses, permissions)
migrations/        D1 SQL migrations (generated by drizzle-kit)
test/              unit tests (vitest) + e2e suite with Shopify/Steadfast mock server
docs/API_NOTES.md  API research: endpoints, auth, scopes, limits, what is not supported
```

## Deployment

No `.env` file or secrets are needed. Every credential is entered in the app.

### 1. Deploy
```bash
npm install
npx wrangler login
npm run deploy
```
On the first deploy, Wrangler **creates the D1 database automatically** and writes its ID into
`wrangler.jsonc`; commit that change. Database migrations run automatically when the Worker starts.

Alternatively, connect the GitHub repo in the Cloudflare dashboard (Workers & Pages → Create →
Import a repository). Use `npm run build` as the build command and `npx wrangler deploy` as the
deploy command.

Webhook URLs follow whatever domain the app is served on: the `*.workers.dev` URL, or a custom
domain added in Cloudflare.

### 2. First login
Open the URL and create the **owner** account.

### 3. Create the Shopify app (Dev Dashboard)
1. In the Shopify **Dev Dashboard**, create an app in the same organization as the store.
2. Add the Admin API scopes: `read_orders`, `write_orders`, `read_customers`,
   `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders`.
   Add `read_all_orders` if you want to import orders older than 60 days.
3. Request **protected customer data** access for name, email, phone and address.
4. Release a version and install the app on the store.

### 4. Connect everything in Settings → Connections
1. **Shopify**: enter the store domain (`yourstore.myshopify.com`), the Client ID and the Client
   secret. Click **Save**, then **Test connection**, then **Register webhooks**.
2. **Steadfast**: enter the API key and Secret key from the Steadfast panel. Click **Save**, then
   **Test connection**.
3. **Steadfast webhook**: copy the *Callback URL* and the *Auth Token (Bearer)* shown on the same
   page into Steadfast panel → API → Webhook. The token is generated automatically.
4. **Label service**: in Settings → API keys, create a key and give it to the label service. See
   [docs/DISPATCH_API.md](docs/DISPATCH_API.md).

### 5. Import existing orders
Go to Sync & webhooks → *Start import*. Imported orders are never booked.

### Optional
- **Encrypt credentials at rest**: before saving the connections, run
  `npx wrangler secret put APP_ENCRYPTION_KEY` with a long random value, such as the output of
  `openssl rand -hex 32`. Credentials are always kept server-side and are only ever shown masked;
  this adds AES-GCM encryption inside D1.
- **Worker secrets instead of the dashboard**: any of `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`,
  `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `STEADFAST_API_KEY`,
  `STEADFAST_SECRET_KEY` and `STEADFAST_WEBHOOK_TOKEN` can be set with `wrangler secret put`. A
  secret overrides the dashboard value.
- **Plan**: Workers Paid is recommended, for CPU time on login hashing and for subrequest headroom.

### Recommended hardening
- Put the dashboard behind **Cloudflare Access** (Zero Trust) for an extra login layer. The
  `/webhooks/*` paths must stay publicly reachable, so add a bypass policy for them.
- Staff use their own accounts. Give them the least role they need: `operator` for booking,
  `packer` for printing, `viewer` for read-only.

## Local development

```bash
npm run dev                            # http://localhost:5173 — Worker + React with HMR
```
To trigger the cron locally, open
`http://localhost:5173/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*`.

## Tests

```bash
npm test                 # unit tests (phone normalization, status mapping, HMAC, booking validation, …)
npm run typecheck
```

The end-to-end suite has 42 checks. It covers the following, against a mock Shopify/Steadfast
API:
- setup, login, and connecting Shopify and Steadfast from the dashboard
- webhooks with HMAC and bearer auth
- idempotency and duplicate detection
- manual booking and duplicate-booking refusal
- partial fulfillment on pickup
- polling recovery, returns, rebooking and payouts
- calling confirmation and Shopify In progress
- the print/dispatch API: concurrent claims, expiry, idempotent replays, reprints, summary and
  scan-to-sort (WebSocket) and mark-sorted
- Shopify-side cancel and edits
- cancel and delete fallback
- import, CSV export and permissions

To run it:

```bash
# .dev.vars for the mock run (the suite enters credentials through Settings → Connections):
#   SHOPIFY_ADMIN_URL_OVERRIDE=http://localhost:8790
#   STEADFAST_BASE_URL=http://localhost:8790/api/v1
rm -rf .wrangler
node test/e2e/mock-server.mjs &   # mock APIs on :8790
npm run dev &                      # app on :5173
npm run test:e2e
```

## How sync stays reliable

| Concern | Approach |
|---|---|
| Webhook authenticity | Shopify HMAC-SHA256 on the raw body (constant-time); Steadfast bearer token (constant-time) |
| Duplicates | `webhook_events (provider, external_id)` unique: Shopify `X-Shopify-Webhook-Id`, Steadfast `Idempotency-Key` or a payload hash |
| Out-of-order events | Shopify `updated_at` watermark per order; late Steadfast updates are ignored once a consignment is final |
| Processing failures | The event is stored first and acknowledged; failed events are retried by the cron for 2 days |
| Missed webhooks | Every 5 min, active consignments not updated in 30 min are polled. Every hour, Shopify orders updated since the watermark are reconciled |
| Shopify calls after courier events | The D1 `jobs` outbox runs immediately via `waitUntil`, then retries with exponential backoff (8 attempts) |
| Double printing | Single-statement conditional claims (`label_status = 'unprinted'`), printed only on explicit confirmation, idempotency keys, late confirmations honoured, reprints only by audited request |
| Double booking | Active-consignment check plus a unique invoice reserved in D1 before calling Steadfast. An uncertain outcome (timeout) is kept as *unconfirmed* and reconciled by invoice |
| Double fulfillment | Shopify fulfillment-order `remainingQuantity` is the source of truth; job keys are unique per order and consignment |
| Rate limits | Shopify cost-based throttling with backoff; `429` / `5xx` retries for both APIs |
| Data retention | Processed webhook payloads and finished jobs are pruned after 60 days |

## Security notes
- API credentials are stored server-side, either in D1 (entered in Settings, optionally encrypted
  with `APP_ENCRYPTION_KEY`) or as Worker secrets. The browser only ever sees masked hints.
- Sessions are random 256-bit tokens. Only their SHA-256 hash is stored, and they are sent in
  `HttpOnly`, `Secure`, `SameSite=Lax` cookies with a 14-day sliding expiry.
- Passwords are hashed with PBKDF2-SHA256 (100k iterations, the Workers maximum).
- Login is rate-limited per email and per IP.
- State-changing requests need an `X-Requested-With` header, which blocks CSRF.
- Each route checks permissions server-side, and every action is written to the activity log.
- CSV export neutralises spreadsheet formula injection.
