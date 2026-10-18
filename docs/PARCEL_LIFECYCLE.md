# Parcel lifecycle: from order to delivery

Every parcel moves through the same steps. Steps 1–4 are ours; step 5 and beyond come from Steadfast.

| # | Step | Who moves it | What the system records |
|---|------|--------------|-------------------------|
| 1 | **Booked** | auto-book timer or staff | `orders.bookedAt`, `shipBy` (pickup day), consignment row, `label_ready` event |
| 2 | **Label printed** | print queue / label service | `printedAt`, `printCount`, `printed` / `reprint_requested` events |
| 3 | **Scanned = packed** | scanner at the packing table | `sortedAt`, `sortedBy`, `sorted` event (with scan batch) |
| 4 | **Handed to rider** | staff tick the handover checklist | pickup row (rider name/phone), `handedOverAt`, `handed_over` event |
| 5 | **Picked up** | Steadfast, automatically | status leaves `in_review` (webhook or poll) → `dispatchedAt`, `dispatched` event |
| 6 | In transit / hold / delivered / returned | Steadfast | every status and tracking step in `tracking_events` |

**Steadfast has no pickup or handover API.** Step 4 is our own record; step 5 is Steadfast telling
us it has the parcel. No API call is needed to "dispatch" a parcel, and scanning never marks a
parcel dispatched.

## Same-day dispatch and carry-over

- At booking each parcel gets a **ship-by date**: today if it was confirmed before the cut-off
  (Settings → Workflow, default 16:00), otherwise tomorrow.
- **Pickup today** lists everything due today and where it is. Anything already packed is "Ready",
  even if it was only due tomorrow: if the rider is here, it goes.
- **Courier arrived → hand over**: the checklist pre-selects every scanned parcel. Untick what the
  rider doesn't take. Only scanned, not-cancelled parcels can be handed over, and one conditional
  update makes double clicks or two devices harmless.
- **Left behind?** Nothing to do. After midnight the cron moves every parcel still here to today,
  adds one to `carryOverCount` and logs `carried_over`. Those parcels show "Late N days" at the top of
  the next day's list until they leave.
- **Rider didn't actually take it?** "Undo handover" puts it back to Ready (logged as
  `handover_undone`).
- **Handed over but Steadfast never confirms?** It shows as "Rider has it · not confirmed" from the
  next day, and on Stuck parcels after `handoverConfirmHours`. Call the rider.
- **Picked up without the checklist?** When Steadfast confirms the pickup, the handover time is
  filled in automatically; if it was never scanned either, `picked_up_unscanned` is logged so the
  owner report can show packing discipline.

## Orders cancelled or deleted in Shopify

- **Cancelled**: as before. Not printable, the scanner says STOP, the pickup page says "pull out".
- **Deleted** (`orders/delete` webhook, or found by the 30-minute existence check if the webhook was
  missed): recorded in `shopifyDeletedAt` and treated as cancelled everywhere.
  - No parcel yet → archived.
  - Parcel not yet picked up → stays visible with the "Order was deleted in Shopify" flag. Cancel it
    in the Steadfast portal (Steadfast has no cancel API); the flag clears by itself when Steadfast
    reports it cancelled.
  - Parcel already with Steadfast → create a return request from the Courier tab.
- Orders older than 55 days are never treated as deleted just because Shopify returns nothing for
  them (Shopify hides orders older than 60 days without the `read_all_orders` scope).

## Parcels deleted in the Steadfast portal

A parcel deleted before pickup no longer exists in Steadfast. Its status lookups answer "not found"
or `unknown`. Before, this showed as `cancelled → unknown`. Now:

- "not found", or `unknown` for a parcel that was never picked up → status **`deleted`** (our own
  final status, stage *cancelled*). The order goes back to *cancelled* and can be rebooked.
- A finished parcel (delivered, cancelled, deleted) never goes back to an open status from a poll.
- `unknown` after pickup is still a real courier problem and is shown as such.

## What is stored (for tracking, analytics and debugging)

| Table | Holds |
|-------|-------|
| `orders` | the latest state and the time of every milestone |
| `dispatch_events` | every warehouse step: label ready/printed/reprinted, scanned, handed over, undone, carried over, dispatched |
| `tracking_events` | every Steadfast status and tracking step (webhook, poll and full history), with the source |
| `call_logs` | every confirmation call and its outcome |
| `sms_messages` | every SMS: text, number, provider answer |
| `activity_log` | every staff and system action with details |
| `webhook_events` | raw webhook bodies, kept 180 days |
| `pickups` | each courier handover: rider, counts, who did it |

The order drawer's **Journey** tab merges all of these into one timeline, with filters per source,
and shows the time between milestones (placed → confirmed → booked → printed → packed → handed
over → picked up → delivered → paid out).
