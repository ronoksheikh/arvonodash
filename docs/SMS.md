# Customer SMS

Uses an sms.net.bd-compatible API: `POST {SMS_API_URL}/sendsms` with `api_key`, `msg`, `to`
(form-encoded, so special characters need no manual URL encoding), and `GET /user/balance/`.

## Setup (server-side only)

```bash
npx wrangler secret put SMS_API_KEY      # required
npx wrangler secret put SMS_SENDER_ID    # optional, an approved sender ID
# SMS_API_URL defaults to https://api.sms.net.bd
```

Or in the Cloudflare dashboard: Workers → this Worker → Settings → Variables and Secrets.
The key is never stored in D1 and never sent to the browser.

## Behaviour

- **Off by default.** Settings → SMS → "Automatic SMS" switches it on. Manual messages work whenever
  the key is set.
- Moments: order placed, confirmed, dispatched (Steadfast pickup), delivered, on hold, returned,
  cancelled. Each can be switched on or off and has its own template.
- Each order gets each automatic message **at most once** (job key `sms:{moment}:{order}`), however
  many webhooks or polls report the change. A combined parcel sends one message naming all orders.
- "Order placed" is only sent for orders less than 6 hours old, never during a historical import.
- Messages are checked again when they are sent: an order cancelled meanwhile gets no "confirmed".
- Templates use placeholders: `{name}`, `{full_name}`, `{order}`, `{link}`, `{status}`,
  `{address}`, `{cod}`, `{total}`, `{tracking_code}`, `{shop}`, `{shop_phone}`. Unknown ones stay
  as typed so a typo is visible in the preview.
- `{link}` uses the tracking domain (e.g. `https://track.arvono.store/t/…`).
- English text: 160 characters per SMS. Bangla switches to Unicode: 70 per SMS. The editor shows the
  count.

## Errors

| Code | Meaning | What happens |
|------|---------|--------------|
| 0 | Sent | |
| 409 / network / 5xx | Provider-side problem | retried with backoff |
| 405, 410, 411, 413, 417, 421 | Account problem (key, expiry, sender ID, balance, not recharged) | not retried; shown in Settings → SMS until a message goes through |
| other 4xx | Bad number, empty or too long, blocked | not retried; shown on the message |

Every attempt is in `sms_messages` and on the order's SMS and Journey tabs.
