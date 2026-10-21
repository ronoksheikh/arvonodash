import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb } from "../db";
import { webhookEvents } from "../db/schema";
import { hmacSha256Base64, hmacSha256Hex, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { nowIso } from "../lib/util";
import { processShopifyEvent, processSteadfastEvent, STEADFAST_PARCEL_EVENTS, syncPayments, type SteadfastWebhook } from "../services/sync";
import { processJobs } from "../services/jobs";
import { CARRYBEE_WEBHOOK_STATUS, webhookSecretMatches } from "../services/carrybee";
import { setValue } from "../services/settings";
import { processCarrybeeEvent, type CarrybeeWebhook } from "../services/carrybeeEvents";

export const webhookRoutes = new Hono<AppEnv>();

/**
 * Stores the event (deduplicated by provider + external id), processes it inline,
 * and always acknowledges once stored. Failures are retried from D1 by the cron.
 */
async function ingest(
  env: AppEnv["Bindings"],
  provider: "shopify" | "steadfast" | "carrybee",
  externalId: string,
  topic: string,
  rawBody: string,
  process: () => Promise<string>,
) {
  const db = getDb(env.DB);
  const inserted = await db
    .insert(webhookEvents)
    .values({ provider, externalId, topic, payload: rawBody, receivedAt: nowIso() })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id })
    .get();
  if (!inserted) return "duplicate";
  try {
    const status = await process();
    await db.update(webhookEvents).set({ status, attempts: 1, processedAt: nowIso() }).where(eq(webhookEvents.id, inserted.id));
    return status;
  } catch (err) {
    await db
      .update(webhookEvents)
      .set({ status: "failed", attempts: 1, error: (err as Error).message.slice(0, 1000) })
      .where(eq(webhookEvents.id, inserted.id));
    return "failed";
  }
}

// Shopify: HMAC-SHA256 of the raw body with the app's client secret, base64, in X-Shopify-Hmac-Sha256.
webhookRoutes.post("/shopify", async (c) => {
  const secret = c.env.SHOPIFY_WEBHOOK_SECRET || c.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) return c.text("Webhook secret not configured", 503);
  const raw = await c.req.text();
  const expected = await hmacSha256Base64(secret, raw);
  const received = c.req.header("X-Shopify-Hmac-Sha256") ?? "";
  if (!timingSafeEqual(expected, received)) return c.text("Invalid signature", 401);

  const shop = c.req.header("X-Shopify-Shop-Domain");
  if (shop && c.env.SHOPIFY_SHOP_DOMAIN && shop !== c.env.SHOPIFY_SHOP_DOMAIN) return c.text("Unknown shop", 403);
  const topic = c.req.header("X-Shopify-Topic") ?? "unknown";
  const webhookId = c.req.header("X-Shopify-Webhook-Id") ?? (await sha256Hex(raw));
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.text("Invalid JSON", 400);
  }
  const result = await ingest(c.env, "shopify", webhookId, topic, raw, () => processShopifyEvent(getDb(c.env.DB), topic, payload));
  if (result === "processed") c.executionCtx.waitUntil(processJobs(c.env, getDb(c.env.DB), { limit: 5 }));
  return c.json({ ok: true, result });
});

// Steadfast: "Auth Token (Bearer)" configured in the Steadfast panel, sent as Authorization: Bearer <token>.
// Newer deliveries also sign the raw body: X-Signature = hex HMAC-SHA256 keyed with the same token.
webhookRoutes.post("/steadfast", async (c) => {
  const token = c.env.STEADFAST_WEBHOOK_TOKEN;
  if (!token) return c.json({ status: "error", message: "Webhook token not configured" }, 503);
  const auth = c.req.header("Authorization") ?? "";
  if (!timingSafeEqual(auth, `Bearer ${token}`)) return c.json({ status: "error", message: "Unauthorized" }, 401);

  const raw = await c.req.text();
  const signature = c.req.header("X-Signature");
  if (signature !== undefined && !timingSafeEqual(signature.trim().toLowerCase(), await hmacSha256Hex(token, raw))) {
    return c.json({ status: "error", message: "Invalid signature" }, 401);
  }
  let payload: SteadfastWebhook;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ status: "error", message: "Invalid JSON" }, 400);
  }
  if (!payload || typeof payload !== "object") return c.json({ status: "error", message: "Invalid payload" }, 400);
  const type = payload.notification_type ?? "delivery_status";
  // Parcel events must name the parcel; account events (payouts, return lists, pickups) don't.
  if (STEADFAST_PARCEL_EVENTS.has(type) && !payload.consignment_id && !payload.invoice && !payload.tracking_code) {
    return c.json({ status: "error", message: "Missing consignment reference" }, 400);
  }
  const externalId =
    c.req.header("Idempotency-Key") ??
    (await sha256Hex(raw));
  const result = await ingest(c.env, "steadfast", externalId, type, raw, () => processSteadfastEvent(getDb(c.env.DB), payload));
  // Run any fulfillment this update queued without making Steadfast wait for Shopify.
  if (result === "processed") c.executionCtx.waitUntil(processJobs(c.env, getDb(c.env.DB), { limit: 5 }));
  // A payout was made: pull it now instead of waiting for the 3-hourly sync.
  if (result === "processed" && type === "payment_request") c.executionCtx.waitUntil(syncPayments(c.env, getDb(c.env.DB), 1).catch(() => {}));
  return c.json({ status: "success", message: "Webhook received successfully." });
});

// Carrybee: the integration secret (Settings → Connections) arrives in X-CB-Webhook-Integration-Header.
// Carrybee expects 202 Accepted with the same header echoed back; no signature scheme is documented.
webhookRoutes.post("/carrybee", async (c) => {
  const secret = c.env.CARRYBEE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Webhook secret not configured" }, 503);
  const received = c.req.header("X-CB-Webhook-Integration-Header");
  const db = getDb(c.env.DB);
  if (!webhookSecretMatches(c.env, received)) {
    // Shown in Settings → Connections → Carrybee, so a wrong or missing secret is easy to spot.
    // Only the last 4 characters of what arrived are kept.
    await setValue(db, CARRYBEE_WEBHOOK_STATUS, {
      ok: false,
      at: nowIso(),
      reason: received ? "mismatch" : "missing",
      receivedHint: received ? `…${received.trim().slice(-4)}` : null,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }
  await setValue(db, CARRYBEE_WEBHOOK_STATUS, { ok: true, at: nowIso(), reason: null, receivedHint: null });
  c.header("X-CB-Webhook-Integration-Header", secret);
  const raw = await c.req.text();
  let payload: CarrybeeWebhook;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!payload || typeof payload !== "object") return c.json({ error: "Invalid payload" }, 400);
  // The integration check Carrybee sends when the URL is saved carries no parcel event.
  if (!payload.event) return c.json({}, 202);
  const result = await ingest(c.env, "carrybee", await sha256Hex(raw), payload.event, raw, () => processCarrybeeEvent(getDb(c.env.DB), payload));
  if (result === "processed") c.executionCtx.waitUntil(processJobs(c.env, getDb(c.env.DB), { limit: 5 }));
  return c.json({ result }, 202);
});
