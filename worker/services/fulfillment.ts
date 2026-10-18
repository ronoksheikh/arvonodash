import { eq } from "drizzle-orm";
import type { DB } from "../db";
import type { Env } from "../env";
import { consignments, orders } from "../db/schema";
import { createFulfillment, getFulfillmentOrders } from "./shopify";
import { getSettings } from "./settings";
import { logActivity } from "./activity";
import { trackingUrl } from "./steadfast";
import { nowIso, PermanentError } from "../lib/util";

const FULFILLABLE_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);

/**
 * Marks the Shopify order fulfilled for the items in a consignment, with Steadfast tracking.
 * Idempotent: Shopify's remaining quantities on fulfillment orders are the source of truth,
 * so re-running never fulfills an item twice.
 */
export async function fulfillOrder(env: Env, db: DB, orderId: number, consignmentRowId: number) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new PermanentError(`Order ${orderId} not found`);
  const consignment = await db.select().from(consignments).where(eq(consignments.id, consignmentRowId)).get();
  if (!consignment?.trackingCode) throw new PermanentError("Consignment has no tracking code");
  if (order.fulfillmentState === "fulfilled") return;

  const fail = async (message: string, permanent = false) => {
    await db.update(orders).set({ fulfillmentState: "failed", fulfillmentError: message, updatedAt: nowIso() }).where(eq(orders.id, orderId));
    throw permanent ? new PermanentError(message) : new Error(message);
  };

  const info = await getFulfillmentOrders(env, db, order.shopifyId);
  if (!info) return fail("Order no longer exists in Shopify", true);
  if (info.cancelledAt) {
    await db.update(orders).set({ fulfillmentState: "skipped", fulfillmentError: "Order is cancelled in Shopify" }).where(eq(orders.id, orderId));
    return;
  }

  // Which line items (and how many) this consignment carries. Empty = everything remaining.
  const wanted = new Map((consignment.lineItems ?? []).map((li) => [li.lineItemId, li.quantity]));
  const plan: { fulfillmentOrderId: string; lineItems?: { id: string; quantity: number }[] }[] = [];
  const blocked: string[] = [];

  for (const fo of info.fulfillmentOrders) {
    const remaining = fo.lineItems.filter((li) => li.remainingQuantity > 0);
    if (!remaining.length) continue;
    const relevant = wanted.size ? remaining.filter((li) => wanted.has(li.lineItemId)) : remaining;
    if (!relevant.length) continue;
    if (!FULFILLABLE_STATUSES.has(fo.status) || !fo.canFulfill) {
      blocked.push(`${fo.location ?? "location"}: ${fo.status.toLowerCase()}`);
      continue;
    }
    if (wanted.size) {
      const lineItems = relevant.map((li) => {
        const qty = Math.min(li.remainingQuantity, wanted.get(li.lineItemId)!);
        wanted.set(li.lineItemId, wanted.get(li.lineItemId)! - qty);
        return { id: li.id, quantity: qty };
      }).filter((li) => li.quantity > 0);
      if (lineItems.length) plan.push({ fulfillmentOrderId: fo.id, lineItems });
    } else {
      plan.push({ fulfillmentOrderId: fo.id });
    }
  }

  if (!plan.length) {
    if (blocked.length) return fail(`Fulfillment order not fulfillable (${blocked.join(", ")}). Release the hold in Shopify, then retry.`);
    // Nothing left to fulfill — already fulfilled in Shopify (e.g. manually).
    await db
      .update(orders)
      .set({ fulfillmentState: "fulfilled", fulfillmentError: null, fulfilledAt: order.fulfilledAt ?? nowIso(), updatedAt: nowIso() })
      .where(eq(orders.id, orderId));
    return;
  }

  const appSettings = await getSettings(db);
  const tracking = { company: appSettings.trackingCompany, number: consignment.trackingCode, url: trackingUrl(env, consignment.trackingCode) };
  const fulfillmentIds = [...(order.shopifyFulfillmentIds ?? [])];
  for (const step of plan) {
    try {
      const f = await createFulfillment(env, db, { ...step, tracking, notifyCustomer: appSettings.notifyCustomer });
      fulfillmentIds.push(f.id);
      // Persist progress after each call so a retry never repeats a completed step.
      await db.update(orders).set({ shopifyFulfillmentIds: fulfillmentIds }).where(eq(orders.id, orderId));
    } catch (err) {
      return fail(`Shopify fulfillment failed: ${(err as Error).message}`);
    }
  }

  await db
    .update(orders)
    .set({
      fulfillmentState: "fulfilled",
      fulfillmentError: blocked.length ? `Some items not fulfilled: ${blocked.join(", ")}` : null,
      fulfilledAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(eq(orders.id, orderId));
  await logActivity(db, "system", "order.fulfilled", {
    entityType: "order",
    entityId: orderId,
    orderId,
    details: { trackingCode: consignment.trackingCode, fulfillments: plan.length, partial: wanted.size > 0 },
  });
}
