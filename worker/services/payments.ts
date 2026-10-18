import { eq } from "drizzle-orm";
import type { DB } from "../db";
import type { Env } from "../env";
import { consignments, orders } from "../db/schema";
import { logActivity } from "./activity";
import { markOrderAsPaid } from "./shopify";
import { nowIso, PermanentError } from "../lib/util";

/** Shopify statuses that still owe money (the only ones we mark paid). */
const UNPAID = new Set(["pending", "partially_paid", "authorized"]);

/**
 * Job: Steadfast confirmed the delivery, so mark the Shopify order paid. Skipped (with a reason on
 * the order) when the collected cash doesn't cover the balance, e.g. the COD was lowered in
 * Steadfast; staff then record the payment in Shopify themselves.
 */
export async function markPaidAfterDelivery(env: Env, db: DB, orderId: number, consignmentRowId: number) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new PermanentError(`Order ${orderId} not found`);
  if (order.shopifyPaidAt || !UNPAID.has(order.financialStatus ?? "")) return;
  const c = await db.select().from(consignments).where(eq(consignments.id, consignmentRowId)).get();
  if (!c || c.stage !== "delivered") return;

  // A combined parcel collects for every order in it.
  const group = await db.select({ outstanding: orders.outstanding }).from(orders).where(eq(orders.activeConsignmentId, c.id)).all();
  const due = group.reduce((s, o) => s + o.outstanding, 0);
  const collected = c.collectedAmount ?? c.codAmount;
  if (collected + 1 < due) {
    await logActivity(db, "system", "order.mark_paid_skipped", {
      entityType: "order",
      entityId: orderId,
      orderId,
      details: { collected, due, reason: "Collected cash is less than the Shopify balance" },
    });
    return;
  }
  const r = await markOrderAsPaid(env, db, order.shopifyId);
  await db
    .update(orders)
    .set({ shopifyPaidAt: nowIso(), financialStatus: r.financialStatus ?? "paid", outstanding: 0, updatedAt: nowIso() })
    .where(eq(orders.id, orderId));
  await logActivity(db, "system", "order.marked_paid", { entityType: "order", entityId: orderId, orderId, details: { collected } });
}
