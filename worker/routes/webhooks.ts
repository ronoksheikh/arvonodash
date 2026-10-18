import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb } from "../db";
import { webhookEvents } from "../db/schema";
import { hmacSha256Base64, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { nowIso } from "../lib/util";
import { processShopifyEvent, processSteadfastEvent, type SteadfastWebhook } from "../services/sync";
import { processJobs } from "../services/jobs";

export const webhookRoutes = new Hono<AppEnv>();

/**
 * Stores the event (deduplicated by provider + external id), processes it inline,
 * and always acknowledges once stored. Failures are retried from D1 by the cron.
 */
async function ingest(
  env: AppEnv["Bindings"],
  provider: "shopify" | "steadfast",
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
webhookRoutes.post("/steadfast", async (c) => {
  const token = c.env.STEADFAST_WEBHOOK_TOKEN;
  if (!token) return c.json({ status: "error", message: "Webhook token not configured" }, 503);
  const auth = c.req.header("Authorization") ?? "";
  if (!timingSafeEqual(auth, `Bearer ${token}`)) return c.json({ status: "error", message: "Unauthorized" }, 401);

  const raw = await c.req.text();
  let payload: SteadfastWebhook;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ status: "error", message: "Invalid JSON" }, 400);
  }
  if (!payload || typeof payload !== "object" || (!payload.consignment_id && !payload.invoice && !payload.tracking_code)) {
    return c.json({ status: "error", message: "Missing consignment reference" }, 400);
  }
  const type = payload.notification_type ?? "delivery_status";
  const externalId =
    c.req.header("Idempotency-Key") ??
    (await sha256Hex([type, payload.consignment_id, payload.invoice, payload.status, payload.tracking_message, payload.updated_at].join("|")));
  const result = await ingest(c.env, "steadfast", externalId, type, raw, () => processSteadfastEvent(getDb(c.env.DB), payload));
  // Run any fulfillment this update queued without making Steadfast wait for Shopify.
  if (result === "processed") c.executionCtx.waitUntil(processJobs(c.env, getDb(c.env.DB), { limit: 5 }));
  return c.json({ status: "success", message: "Webhook received successfully." });
});
