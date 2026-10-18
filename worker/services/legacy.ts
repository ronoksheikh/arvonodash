import { eq } from "drizzle-orm";
import type { DB } from "../db";
import type { Env } from "../env";
import { consignments, orders } from "../db/schema";
import type { NormalizedOrder } from "./shopify";
import * as steadfast from "./steadfast";
import { buildAddress } from "./orders";
import { logActivity } from "./activity";
import { nowIso, truncate } from "../lib/util";

/**
 * Orders that were shipped before ARVONO (booked in the Steadfast panel or another app) must not
 * land in the calling / booking queues. They are linked to their existing Steadfast parcel or
 * marked as handled outside ARVONO. Nothing is booked or fulfilled here.
 */

const STEADFAST = /steadfast|packzy/i;
const FULFILLED = new Set(["fulfilled", "partially_fulfilled", "partial"]);

function steadfastShipment(shipments: NormalizedOrder["shipments"]) {
  return (
    shipments.find((s) => STEADFAST.test(s.company ?? "") || STEADFAST.test(s.url ?? "")) ??
    // No carrier recorded: Steadfast tracking codes are short upper-case alphanumerics (e.g. 15BAEB8A).
    shipments.find((s) => !s.company && !s.url && /^[A-Z0-9]{6,12}$/.test(s.number))
  );
}

async function linkConsignment(
  db: DB,
  order: typeof orders.$inferSelect,
  data: { invoice: string; trackingCode: string | null; consignmentId?: string | null; status: string; stage: string; pickedUp: boolean; source: string },
) {
  const now = nowIso();
  const row = await db
    .insert(consignments)
    .values({
      orderId: order.id,
      invoice: data.invoice,
      consignmentId: data.consignmentId ?? null,
      trackingCode: data.trackingCode,
      status: data.status,
      stage: data.stage,
      recipientName: order.customerName ?? "",
      recipientPhone: order.phone ?? order.rawPhone ?? "",
      recipientAddress: truncate(buildAddress(order), 250),
      codAmount: Math.max(0, Math.round(order.outstanding)),
      note: `Linked from existing shipment (${data.source})`,
      pickedUpAt: data.pickedUp ? order.shopUpdatedAt : null,
      lastStatusAt: now,
      createdAt: order.shopCreatedAt,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: consignments.id })
    .get();
  if (!row) return false;
  await db
    .update(orders)
    .set({
      courierStage: data.stage,
      activeConsignmentId: row.id,
      callingStatus: "confirmed",
      processingStatus: "in_progress",
      bookedAt: order.shopCreatedAt,
      // Already shipped: never offer these to the label printer.
      labelStatus: data.pickedUp ? "printed" : "not_ready",
      dispatchStatus: data.pickedUp ? "courier_received" : "pending",
      courierReceivedAt: data.pickedUp ? order.shopUpdatedAt : null,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id));
  await logActivity(db, "system", "courier.linked_existing", { entityType: "order", entityId: order.id, orderId: order.id, details: { ...data } });
  return true;
}

/** Called after every Shopify upsert. No API calls; courier status is filled in by polling. */
export async function linkFromShopifyFulfillment(db: DB, orderId: number, shipments: NormalizedOrder["shipments"]) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order || order.activeConsignmentId || order.courierStage !== "unbooked") return;
  if (!FULFILLED.has(order.shopifyFulfillmentStatus ?? "")) return;

  const ship = steadfastShipment(shipments);
  if (ship) {
    await linkConsignment(db, order, {
      invoice: `shopify-${order.shopifyId}-${ship.number}`,
      trackingCode: ship.number,
      status: "linked",
      stage: "in_transit",
      pickedUp: true,
      source: "Shopify fulfillment",
    });
    return;
  }
  // Fulfilled in Shopify by another courier or by hand: keep it out of the work queues.
  if (order.callingStatus !== "confirmed") {
    await db
      .update(orders)
      .set({ callingStatus: "confirmed", processingStatus: "in_progress", fulfillmentState: "skipped", updatedAt: nowIso() })
      .where(eq(orders.id, order.id));
  }
}

/**
 * Import only: asks Steadfast whether an unfulfilled order was already booked in the Steadfast
 * panel under its order number (invoice "1001" or "#1001").
 */
export async function matchByInvoice(env: Env, db: DB, orderId: number) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order || order.activeConsignmentId || order.courierStage !== "unbooked" || order.cancelledAt) return false;
  if (FULFILLED.has(order.shopifyFulfillmentStatus ?? "")) return false;
  const candidates = [...new Set([order.name.replace(/^#/, ""), order.name, order.orderNumber ? String(order.orderNumber) : ""].filter(Boolean))];
  for (const invoice of candidates) {
    const status = await steadfast.getStatusByInvoice(env, invoice);
    if (!status) continue;
    const pickedUp = steadfast.isPickedUpStatus(status);
    return linkConsignment(db, order, {
      invoice,
      trackingCode: null,
      status,
      stage: steadfast.stageForStatus(status, pickedUp),
      pickedUp,
      source: "Steadfast invoice match",
    });
  }
  return false;
}
