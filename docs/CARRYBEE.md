# Carrybee courier

Carrybee is a second courier next to Steadfast. It is **off** until you switch to it:
Settings → Connections → **Courier for new bookings**. Switching only changes **new** bookings
(manual, bulk and auto-booking); every parcel keeps the courier it was booked with until it is
delivered or returned. You can switch back at any time.

## Connect (Settings → Connections → Carrybee)

1. **Environment**: Sandbox for testing, Production for live parcels. Save first. Credentials
   belong to one environment.
2. **Client-ID, Client-Secret, Client-Context** from Carrybee → API Credentials. They are stored
   server-side like the Steadfast keys: masked in the dashboard, optionally encrypted with
   `APP_ENCRYPTION_KEY`. Worker secrets `CARRYBEE_CLIENT_ID` / `CARRYBEE_CLIENT_SECRET` /
   `CARRYBEE_CLIENT_CONTEXT` override them.
3. **Test & load stores**, then choose the **pickup store**. Set the parcel weight (grams; Carrybee
   requires one) and, if wanted, Express delivery.
4. **Webhook**: in Carrybee → Webhook Integration, paste the Webhook URL
   (`https://<dashboard>/webhooks/carrybee`). Copy the **integration secret Carrybee shows there**
   (a UUID like `40489fe0-…`) into *Carrybee's integration secret* in our Settings and save it,
   then press **Open 10-minute setup window** in our Settings and, within 10 minutes, press
   **Add Webhook** at Carrybee (all events ticked).

   Why the window: Carrybee's check (`{"event": "webhook.integration"}`) arrives **without** the
   secret header, yet expects `202` with the secret in `X-CB-Webhook-Integration-Header`. Answering
   that to anyone would hand the secret out, so it is answered only while the window is open, and
   only once. Real parcel events always need the header. Settings shows the last accepted or
   rejected webhook and why (missing header, or a secret that doesn't match).
5. Switch **Courier for new bookings** to Carrybee. It refuses until steps 2–3 are done.

## How bookings are sent

`POST /api/v2/orders` with: store, our invoice as `merchant_order_id`, recipient name, phone,
alternative phone and address, COD (`collectable_amount`, whole taka), item count, weight,
note (`special_instruction`) and item list (`product_description`). City and zone come from
Carrybee's `address-details` lookup when it recognises the address; otherwise they are left out
(both are optional). Carrybee has no separate tracking code, so the consignment ID (e.g. `FX…`)
is used on labels, for scanning and in Shopify. Delivery charge = `delivery_fee` + `cod_fee`.

## Status updates

Webhooks are the main source; the cron reads `GET /orders/{id}/details` as a fallback.

| Carrybee event | Stage here | Notes |
|---|---|---|
| created, pickup-requested, assigned-for-pickup, pickup-failed | Booked | |
| picked | In transit | = dispatched; Shopify fulfillment (on-pickup setting) |
| at-the-sorting-hub … assigned-for-delivery | In transit | rider name and phone shown in the timeline |
| delivery-on-hold, delivery-failed | On hold | reason and remarks shown |
| delivered, exchange | Delivered | collected amount stored; order marked paid in Shopify (if enabled) |
| partial-delivery | Partial delivered | |
| paid-return | Partial delivered | customer paid the delivery charge, product returned |
| returned, returned-at-sorting, returned-in-transit, returned-to-merchant | Returned | return record created |
| pickup-cancelled, or cancelled from the dashboard | Cancelled | can be rebooked |
| paid | — | COD payout recorded (`invoice_id`) |
| updated | — | delivery charge refreshed; a changed COD is flagged on the order |

Rules: a finished parcel never goes back to an open status (Carrybee doesn't promise event order),
duplicate deliveries are stored once, and unknown wording from the details endpoint is ignored
(Carrybee doesn't publish that vocabulary), so the webhook decides.

## Webhook security

Carrybee sends the shared secret in `X-CB-Webhook-Integration-Header`; it is compared in constant
time, and the reply is `202 Accepted` with the same header, as Carrybee requires. Carrybee
documents no signature, so keep the URL on HTTPS and regenerate the secret if it leaks.

## Differences from Steadfast

- **Cancel**: Carrybee parcels can be cancelled from the order (Courier tab → Cancel parcel at
  Carrybee, with a reason). Before pickup the parcel is cancelled at once; after pickup the result
  arrives by webhook.
- **Return requests** stay a Steadfast feature; Carrybee reverse pickups are done in its panel.
- **Fraud check** keeps using Steadfast (when its keys are set), whichever courier books.
- **Customer tracking**: our tracking page shows "Carrybee"; Shopify gets our tracking link,
  because Carrybee has no public tracking page.

Not live-tested: built from the Carrybee API v2 reference. Try a few parcels in Sandbox first.
