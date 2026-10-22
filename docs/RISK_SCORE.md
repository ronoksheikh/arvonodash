# Smart risk score

Every order gets one number from **0 (safe) to 100 (very risky)**, built from everything the dashboard
knows about the customer and the order. It is advice for the calling team: it never cancels, blocks or
holds an order by itself.

| Score | Level | Meaning |
|---|---|---|
| 0–34 | **Safe** (green) | Good signs — book normally |
| 35–59 | **Check** (yellow) | Mixed signs — confirm by phone before booking |
| 60–100 | **Risky** (red) | Strong warning signs — call first, consider an advance delivery charge |

## Where you see it

- **Orders list** — a *Risk* column with the score chip; hover for the reasons. Sort by risk, or filter
  with *Any risk*. Risky orders that aren't booked yet also appear in the **Call first** tab.
- **Order drawer** — the **Risk** tab (its label shows the score in colour) with the full breakdown:
  - *Why this score*: every reason with its points (+ raises the risk, − lowers it), grouped.
  - *This number's order history*: every other order placed with the same phone number — what happened
    to it (received, returned, cancelled, rejected on call, cancelled at the courier, on the way), and
    whether the **name or address was different**.
  - *Courier record*: the Steadfast fraud check (all merchants), with Re-check.
  - *Return rates*: how often orders from the same ad source, campaign and district come back.

## How the score is built

Start at **20**, then add or subtract:

| Signal | Points |
|---|---|
| First order from this number | +5 |
| Each earlier order received | −10 (max −30) |
| Each earlier parcel returned | +22 (max +50) |
| Each earlier parcel cancelled after booking | +12 (max +30) |
| Each earlier order cancelled / rejected before shipping | +8 (max +24) |
| An order cancelled shortly before this one (within the duplicate window — usually a re-order) | +3 |
| Returned/cancelled orders on this number **under another name** | +12 |
| Number used under other names (no bad outcome) | +4, or +10 for 3+ names |
| Steadfast record: risky / mixed / new / good (90%+ delivered) | +30 / +12 / +4 / −10 (−15) |
| Ad source return rate above the shop average (≥15 finished orders) | up to +15 (below average: up to −6) |
| Campaign return rate above average (≥10 finished orders) | up to +12 |
| District return rate above average (≥10 finished orders) | up to +10 |
| Invalid phone · test order · short address | +25 · +20 · +10 |
| Same items ordered again recently · another recent order | +12 · +6 |
| High COD value · large quantity | +8 · +6 |
| Customer tagged blocked / risky / VIP | +60 / +25 / −20 |

Return rates use the last 180 days of delivered/returned orders. Names are compared loosely
("Md. Rahim Uddin" = "Rahim"); addresses ignore case, spaces and punctuation.

Two risk flags come from the same data: **returned_before** (this number returned an earlier parcel) and
**cancelled_before** (this number cancelled or rejected earlier orders). They show in *Review before
booking* like the other flags and can be marked as reviewed.

## When it updates

- When an order arrives or changes in Shopify, after the Steadfast fraud check, and on *Re-check*.
- When one of the customer's orders is delivered, returned or cancelled, their other open orders are
  re-scored.
- Opening the order always shows a fresh score.
- The 5-minute cron scores recent orders that have none yet and refreshes open orders every 6 hours
  (return rates move as parcels finish).

Stored in the `order_risk` table (migration `0011_order_risk.sql`), separate from `orders` because of
D1's 100-column limit. The scoring itself is in `shared/risk.ts` (pure, unit-tested); loading the data
is in `worker/services/riskScore.ts`.

## One-line order status

The orders table and the order drawer show one status line instead of separate calling, courier, label,
dispatch and fulfillment badges:

`Confirmed › Booked (Carrybee) › Printed › Packed › With rider` → `… › In transit` → `… › Delivered`

Earlier steps are grey, the current step is coloured. While an order isn't booked, the first step is the
calling menu (click to set the call outcome). Problems get their own red line underneath: *Cancelled in
Shopify — stop the parcel*, *Shopify fulfillment failed*, *Shopify update failed*. Payment (COD / Prepaid)
moved under the total.
