# Custom tracking domain (track.arvono.store)

Customer links (SMS, labels, "copy link") use the address saved in **Settings → Tracking page**.
On that host the Worker serves only:

- `/t/<token>`: the tracking page
- `/<token>`: redirects to `/t/<token>` (short form)
- `/api/public/*`: tracking data and the domain check
- static assets

`/` redirects to the store website. The dashboard, login, API and webhooks answer 404 there. The
dashboard keeps working on its own address, and old `/t/` links on it keep working.

## DNS and HTTPS

The Worker must receive the hostname, and Cloudflare must hold its certificate.

**A. arvono.store DNS on Cloudflare (recommended).** Moving the nameservers to Cloudflare is free,
and the Shopify store keeps working with the same records.

1. Cloudflare dashboard → Workers & Pages → this Worker → Settings → Domains & Routes → Add →
   **Custom domain** → `track.arvono.store`. Cloudflare creates the DNS record and issues the
   certificate, usually within minutes.
   Or uncomment `"routes": [{ "pattern": "track.arvono.store", "custom_domain": true }]` in
   `wrangler.jsonc` and deploy.
2. Settings → Tracking page → `https://track.arvono.store` → Save → **Check domain**.

**B. DNS stays elsewhere (e.g. Shopify DNS).** A plain CNAME to `*.workers.dev` does not work:
Cloudflare doesn't serve foreign hostnames on workers.dev. Use **Cloudflare for SaaS** (custom
hostnames) on a zone you have on Cloudflare: add `track.arvono.store` as a custom hostname, route it
to this Worker, and create the CNAME `track` → your fallback origin hostname at your DNS provider.
Cloudflare validates and issues the certificate.

"Check domain" runs from your browser: it calls `https://track.arvono.store/api/public/domain-check`
and compares the installation id. A pass means DNS points here and the HTTPS certificate is valid.

The Worker now runs before static assets for every request (`run_worker_first: true`) so it can
tell the two hosts apart; dashboard assets are passed straight through.
