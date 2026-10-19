# Order source (UTM / where the order came from)

Every order shows where it came from: a **channel** (Facebook Ads, Instagram, Google, TikTok,
Direct, Manual draft order…) plus the UTM tags (source, medium, campaign, content, term), the
referring site and the landing page.

## Where the data comes from

1. **Right away, from the order webhook:** `landing_site` (UTM tags in its query string),
   `referring_site`, and UTM tags some themes save as cart attributes (`utm_source`, …).
2. **A few minutes later, from Shopify's customer journey:** `Order.customerJourneySummary` gives
   the first and last visit (source, marketing type, referrer, landing page, UTM parameters), days
   to conversion and the customer's order number. This is what Shopify shows in the admin under
   "Conversion summary". It replaces the webhook data, never the other way round.

The journey is read by the cron every 5 minutes (100 orders per Shopify call, newest first), and
on demand with `POST /api/sync/order-sources`. Shopify needs a little time to build the journey;
orders not ready yet are tried again for up to 48 hours. Orders older than 60 days are skipped
(Shopify only shows them with `read_all_orders`). It needs only the `read_orders` scope. If the
call fails, it pauses for an hour and never affects the order sync.

## Channel rules (shared/attribution.ts)

The **last visit** gets the credit (last click); the first visit is shown too. In order:

1. Draft order → *Manual*; POS → *Point of sale*.
2. UTM source (`fb`, `facebook`, `ig`, `instagram`, `msg`, `google`, `tiktok`, `youtube`, `whatsapp`, email, sms…).
3. Ad click ids in the landing page: `gclid` → Google Ads, `ttclid` → TikTok Ads, `fbclid` → Facebook.
4. Shopify's own visit source, then the referring site's domain.
5. A referrer we don't know → *Other website*; no referrer and no tags → *Direct*.

"Ads" is added when the UTM medium is paid (`cpc`, `paid`, `paid_social`, `ads`…), the UTM source
contains "ads", or Shopify marks the visit as an ad.

## Where you see it

- **Orders list:** Source column (channel + campaign) and filters for source and campaign.
- **Order drawer → Overview:** "Where this order came from", with the first and last visits.
- **Owner report:** orders, confirmations, cancellations, deliveries, returns and delivered value
  per channel and for the top campaigns, which shows which ads bring real customers.
- **CSV export:** source, UTM source, medium, campaign and content, plus referrer and landing page.
