# Dispatch & label printing API (v1)

The external label service uses this API to fetch booked orders, print their labels, and confirm
which labels actually printed. ARVONO does **not** generate labels itself.

Base URL: `https://<your-domain>/api/v1/dispatch`

## Authentication

Create a key in **Settings → API keys**. The key is shown once; only a SHA-256 hash is stored.

```
Authorization: Bearer arv_…
```

| Scope | Allows |
|---|---|
| `dispatch:read` | `GET /printable`, `GET /summary`, `GET /jobs`, `GET /jobs/{id}` |
| `dispatch:print` | `POST /claim`, `POST /printed`, `POST /release` |
| `dispatch:dispatch` | `POST /scan`, `GET /scan/ws`, `POST /mark-sorted`, batches |

Signed-in dashboard staff can call the same endpoints with their session.

## Idempotency

Every `POST` made with an API key **must** send an `Idempotency-Key` header, for example a UUID
per logical request. Retrying with the same key and the same body returns the original response
with the header `Idempotent-Replayed: true`.

| Situation | Response |
|---|---|
| Same key, different body | `422` |
| Same key while the first request is still running | `409` |
| Same key, first request failed with an error | The key is freed, so the retry runs normally |

Keys are kept for 7 days.

## Dates

All dates are **Asia/Dhaka business dates** (`YYYY-MM-DD`, UTC+6). An order belongs to the date it
was **booked with Steadfast**. Each read endpoint accepts exactly one of these forms:

| Parameter | Meaning |
|---|---|
| `date=2026-10-18` | Orders booked on that day (the default is today) |
| `from=2026-10-17&to=2026-10-18` | An inclusive range of up to 62 days |
| `upTo=2026-10-18` | Everything booked up to and including that day. Use it for next-day dispatch so nothing left over from earlier days is missed |

## Label states

```
not_ready ─(booked)→ unprinted ─(claim)→ reserved ─(printed)→ printed
                         ↑                  │
                         └──(release / expiry)┘
printed → unprinted only through an explicit, audited reprint request in the dashboard
```

The rules:
- Fetching (`GET /printable`) **never** changes state.
- A label becomes `printed` **only** through `POST /printed`.
- A printed order is never returned again automatically.
- Only orders whose courier stage is still `booked` (not yet picked up), that are not cancelled,
  and that are not archived can be printed. An order cancelled in Shopify drops out immediately.
- A rebooking (redelivery) creates a new tracking code, so the order becomes `unprinted` again.

## Endpoints

### `GET /printable`
Query parameters: `date` | `from`+`to` | `upTo`, `status` (`unprinted` (the default) | `reserved` |
`printed` | `all`), `limit` (≤500, default 200), `cursor` (pass back the `nextCursor` value).

```json
{
  "range": "2026-10-18", "timezone": "Asia/Dhaka", "status": "unprinted", "count": 1, "nextCursor": null,
  "orders": [{
    "orderId": 12, "orderName": "#1001", "orderNumber": 1001, "shopifyOrderId": "7000123",
    "invoice": "1001", "consignmentId": "1424107", "trackingCode": "15BAEB8A",
    "customer": { "name": "Karim Uddin", "phone": "01812345678", "alternativePhone": null },
    "shippingAddress": { "address": "House 12, Road 5, Dhanmondi, Dhaka, 1209", "city": "Dhaka", "zip": "1209", "country": "Bangladesh" },
    "items": [{ "title": "Cotton Panjabi", "variant": "L", "sku": "PJ-L", "quantity": 1 }],
    "totalQuantity": 1, "codAmount": 900, "deliveryType": "home_delivery", "note": "Call before delivery",
    "bookedAt": "2026-10-18T05:12:00.000Z", "bookedDate": "2026-10-18",
    "labelStatus": "unprinted", "printJobId": null, "reservedUntil": null, "printedAt": null, "printCount": 0,
    "dispatchStatus": "pending", "dispatchedAt": null, "courierReceivedAt": null,
    "trackingUrl": "https://<your-domain>/t/3f9c0a1b2d4e5f607182"
  }]
}
```

The `customer`, `address` and `codAmount` fields are what Steadfast holds for the consignment, so
the label matches the courier's records.
`trackingUrl` is the customer's own ARVONO tracking page for the order; print it as a QR code on
the label if you like. When only some items were shipped (a partial booking),
`items` lists only the quantities in this parcel.

### `POST /claim`
Atomically reserves unprinted orders for one print job. Two concurrent claims can never receive
the same order.

```json
{ "date": "2026-10-18", "limit": 100, "ttlSeconds": 1800 }
```

Instead of a date you can send `{ "orderIds": [12, 13] }`. Only orders that are still unprinted are
reserved.

`ttlSeconds` must be between 60 and 86400 (default 1800).

Response: `{ "jobId": "uuid", "expiresAt": "…", "count": 1, "orders": [ …same shape as /printable… ] }`.
When nothing is available, `jobId` is `null` and `orders` is empty.

A reservation that is never confirmed expires automatically: the cron runs every 5 minutes, and
every `/printable` or `/claim` call also checks. The orders then return to `unprinted`.

### `POST /printed`
Confirms the labels that actually printed. Send any of the following:

| Body | Effect |
|---|---|
| `{ "jobId": "uuid" }` | Marks every order still reserved by this job as printed |
| `{ "jobId": "uuid", "orderIds": [12] }` | Marks only these orders from the job |
| `{ "jobId": "uuid", "failedOrderIds": [13] }` | Marks the rest of the job as printed and releases 13 right away |
| `{ "orderIds": [12] }` | Marks these orders if they are currently reserved by any job |

A late confirmation after the reservation expired is still accepted, as long as no other job has
claimed the order since. Accepting it prevents a double print.

Response:
```json
{ "printed": 1, "released": 0, "results": [ { "orderId": 12, "result": "printed" } ] }
```
Possible `result` values: `printed`, `already_printed`, `not_reserved`, `not_in_job`, `not_found`.

### `POST /release`
Returns reserved orders to the pool, for example after a printer failure.
`{ "jobId": "uuid" }` or `{ "orderIds": [..] }`, plus an optional `reason`.

### `GET /summary?date=YYYY-MM-DD`
```json
{
  "date": "2026-10-18", "timezone": "Asia/Dhaka",
  "confirmedOrders": 40, "bookedConsignments": 38, "unprinted": 3, "reserved": 0, "printed": 35, "printedOnDate": 36,
  "awaitingSort": 5, "sorted": 20, "dispatched": 10, "cancelledAfterBooking": 1,
  "backlog": { "unprinted": 4, "reserved": 0, "awaitingSort": 6, "awaitingPickup": 20 }
}
```

These figures mean:
- `confirmedOrders`: orders confirmed by phone on that day.
- The label and dispatch counts (`unprinted` through `courierReceived`) cover orders booked that
  day.
- `printedOnDate`: labels printed on that day, whatever day they were booked.
- `backlog`: open work across all days.

### Sorting & dispatch
Dispatch states: `pending` → `sorted` (label scanned at the packing table) → `dispatched` (set
**only** by Steadfast, when the parcel's status leaves `in_review`, i.e. the courier picked it up).
The `dispatched` transition also triggers Shopify fulfillment with tracking.

#### `POST /scan`
`{ "code": "1424107", "batchId": "optional" }`. `code` is the **Steadfast consignment ID**, the
barcode on the label. The tracking code, invoice or order number are also accepted.

Response: `{ kind, ok, message, order }`. The possible `kind` values:

| `kind` | Meaning |
|---|---|
| `sorted` | Marked sorted. Also marks the label printed |
| `duplicate` | Already sorted; nothing changes |
| `cancelled` | **Stop**: the order was cancelled in Shopify |
| `already_dispatched` | Steadfast has already picked it up |
| `old_label` | The order was rebooked; this label is no longer valid |
| `not_booked` | The order isn't booked with Steadfast |
| `unknown` | No matching parcel |

#### `GET /scan/ws` (WebSocket)
The fast path, used by the phone scanner page (`/scan` in the dashboard).

| Direction | Message |
|---|---|
| Send | `{"t":"scan","id":"<client id>","code":"1424107","batchId":"…"}` |
| Receive | `{"t":"result","id":"<client id>", …same shape as POST /scan}` |
| Send | `{"t":"summary","batchId":"…"}` |
| Receive | `{"t":"summary","scanned":[…],"remaining":[…],"totals":{…}}` |

Authenticate with the dashboard session or `Authorization: Bearer <key>` (scope
`dispatch:dispatch`).

#### `POST /batches`, `GET /batches/{id}`, `POST /batches/{id}/close`
Scanning sessions (one courier pickup). The summary lists the parcels scanned in the session and
the booked parcels **still not sorted**, so nothing is left behind.

#### `POST /mark-sorted`
`{ "orderIds": [12, 13] }`. Marks parcels sorted without scanning them, for labels that can't be
scanned. `POST /mark-dispatched` is kept as an alias for older clients.

### `GET /jobs`, `GET /jobs/{id}`
Print job history (`reserved | completed | partial | released | expired`) and the per-order event
log of a job.

### Dashboard-only (session)
- `POST /reprint` with `{ orderIds, reason }`. Needs the `labels.reprint` permission and a reason.
  It puts printed labels back in the unprinted pool and records an audit entry.
- `POST /undo-sort` with `{ orderIds, reason }`. Undoes a scan recorded by mistake.
- `GET /board?view=ready|dispatched|received|exceptions` returns the dispatch board.

## Recommended label-service loop

```
every N minutes (or on demand):
  claim = POST /claim { upTo: today, limit: 100 }   (Idempotency-Key: new uuid)
  if claim.jobId is null: stop
  print each label in claim.orders
  POST /printed { jobId, failedOrderIds: [...those that failed] }   (Idempotency-Key: uuid stored with the job)
  on crash before confirming: retry /printed with the SAME Idempotency-Key, or let the reservation expire
```

## Errors
Errors return JSON in the shape `{ "error": "message" }`. The status codes are:

| Status | Meaning |
|---|---|
| `400` | Validation error |
| `401` | Bad or revoked key |
| `403` | Missing scope or permission |
| `404` | Not found |
| `409` | Idempotent request still in progress |
| `422` | Idempotency-Key reused with a different body |
| `5xx` | Safe to retry with the same Idempotency-Key |
