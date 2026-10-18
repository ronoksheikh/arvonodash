import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db";
import type { Env, SessionUser } from "../env";
import { callLogs, orders } from "../db/schema";
import { enqueueJob } from "./jobs";
import { logActivity } from "./activity";
import { markOrderInProgress, reopenOrder, fetchOrder } from "./shopify";
import { HttpError, nowIso } from "../lib/util";
import { CALLING_STATUSES, type CallingStatus } from "../../shared/constants";

/**
 * Calling / verification workflow.
 *   Confirmed → processing "in_progress", mirrored to Shopify natively (fulfillment status "In progress")
 *   anything else (before booking) → processing "new", Shopify fulfillment orders re-opened if needed.
 * Booking with Steadfast stays a separate, manual step.
 */
export async function setCallingStatus(
  db: DB,
  user: SessionUser,
  orderId: number,
  input: { status: string; note?: string | null; callbackAt?: string | null },
) {
  if (!(input.status in CALLING_STATUSES)) throw new HttpError(400, "Invalid calling status");
  const status = input.status as CallingStatus;
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new HttpError(404, "Order not found");
  if (order.cancelledAt && status === "confirmed") throw new HttpError(409, "Order is cancelled in Shopify");
  if (order.courierStage !== "unbooked" && status !== "confirmed" && order.callingStatus === "confirmed") {
    throw new HttpError(409, "Order is already booked with Steadfast; its confirmation can no longer be changed");
  }
  const now = nowIso();
  const counted = status !== "not_called";
  const processing = status === "confirmed" ? "in_progress" : order.processingStatus === "cancelled" ? "cancelled" : "new";
  const processingChanged = processing !== order.processingStatus;
  await db
    .update(orders)
    .set({
      callingStatus: status,
      callAttempts: counted ? sql`${orders.callAttempts} + 1` : orders.callAttempts,
      lastCallAt: counted ? now : order.lastCallAt,
      callbackAt: status === "call_again" || status === "no_answer" ? input.callbackAt ?? null : null,
      confirmedAt: status === "confirmed" ? order.confirmedAt ?? now : null,
      confirmedBy: status === "confirmed" ? order.confirmedBy ?? user.id : null,
      processingStatus: processing,
      ...(processingChanged && !order.cancelledAt ? { shopifySyncStatus: "pending", shopifySyncError: null } : {}),
      updatedAt: now,
    })
    .where(eq(orders.id, orderId));
  await db.insert(callLogs).values({
    orderId,
    outcome: status,
    note: input.note?.trim().slice(0, 2000) || null,
    callbackAt: input.callbackAt ?? null,
    userId: user.id,
    userName: user.name,
    createdAt: now,
  });
  await logActivity(db, user, `calling.${status}`, { entityType: "order", entityId: orderId, orderId, details: input.note ? { note: input.note } : undefined });
  if (processingChanged && !order.cancelledAt) await queueProcessingSync(db, orderId);
  const { scheduleAutoBook, cancelAutoBook } = await import("./autobook");
  let autoBookAt: string | null = null;
  if (status === "confirmed") autoBookAt = order.autoBookAt ?? (await scheduleAutoBook(db, orderId));
  else await cancelAutoBook(db, orderId, null);
  return { processingStatus: processing, shopifySync: processingChanged, autoBookAt };
}

export async function queueProcessingSync(db: DB, orderId: number) {
  return enqueueJob(db, "shopify_processing", `processing:${orderId}`, { orderId }, { reset: true });
}

/** Job: make Shopify's fulfillment status match our processing status. Reads current state, so it is idempotent. */
export async function syncProcessingToShopify(env: Env, db: DB, orderId: number) {
  for (let pass = 0; pass < 2; pass++) {
    const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order || order.cancelledAt || order.archived) return;
    const desired = order.processingStatus;
    try {
      if (desired === "in_progress") {
        // Fulfilled orders don't need (and can't take) an in-progress report.
        if (!["fulfilled", "partially_fulfilled", "partial"].includes(order.shopifyFulfillmentStatus ?? "")) {
          await markOrderInProgress(env, db, order.shopifyId, "Confirmed by phone");
        }
      } else if (desired === "new" && order.courierStage === "unbooked") {
        await reopenOrder(env, db, order.shopifyId);
      }
    } catch (err) {
      await db.update(orders).set({ shopifySyncStatus: "failed", shopifySyncError: (err as Error).message.slice(0, 500) }).where(eq(orders.id, orderId));
      throw err;
    }
    // If staff changed the status while we were talking to Shopify, run once more.
    const after = await db.select({ p: orders.processingStatus }).from(orders).where(eq(orders.id, orderId)).get();
    if (after?.p === desired) {
      await db
        .update(orders)
        .set({
          shopifySyncStatus: desired === "in_progress" ? "synced" : "none",
          shopifySyncError: null,
          shopifySyncedAt: nowIso(),
          ...(desired === "in_progress" && order.shopifyFulfillmentStatus === "unfulfilled" ? { shopifyFulfillmentStatus: "in_progress" } : {}),
          ...(desired === "new" && order.shopifyFulfillmentStatus === "in_progress" ? { shopifyFulfillmentStatus: "unfulfilled" } : {}),
        })
        .where(eq(orders.id, orderId));
      return;
    }
  }
}

/** Job: re-read an order through GraphQL after a webhook (REST payloads can't express "In progress"). */
export async function refreshOrderFromShopify(env: Env, db: DB, shopifyId: string) {
  const fresh = await fetchOrder(env, db, shopifyId);
  if (!fresh) return;
  const { upsertOrder } = await import("./orders");
  const { getSettings } = await import("./settings");
  await upsertOrder(db, fresh, await getSettings(db));
}

/**
 * Applies changes staff made directly in Shopify (admin or mobile app) to our workflow state.
 * Called after every upsert with the previous and new order rows.
 */
export async function applyShopifySideChanges(
  db: DB,
  before: typeof orders.$inferSelect | undefined,
  after: typeof orders.$inferSelect,
) {
  const now = nowIso();
  const log = (outcome: string, note: string) =>
    db.insert(callLogs).values({ orderId: after.id, outcome, note, userName: "Shopify", createdAt: now });

  // Cancelled in Shopify → processing cancelled; label no longer printable.
  if (after.cancelledAt && after.processingStatus !== "cancelled") {
    await db.update(orders).set({ processingStatus: "cancelled", shopifySyncStatus: "none", autoBookAt: null, autoBookNote: "Order cancelled in Shopify" }).where(eq(orders.id, after.id));
    const { onNotPrintable } = await import("./dispatch");
    await onNotPrintable(db, after.id, "Order cancelled in Shopify", { name: "shopify" });
    if (before) await logActivity(db, "shopify", "order.cancelled_in_shopify", { entityType: "order", entityId: after.id, orderId: after.id });
    return;
  }
  if (!before || after.cancelledAt) return;

  const wasInProgress = before.shopifyFulfillmentStatus === "in_progress";
  const isInProgress = after.shopifyFulfillmentStatus === "in_progress";
  const ourSyncInFlight = after.shopifySyncStatus === "pending";

  // Marked "In progress" in Shopify by staff → treat as confirmed.
  if (!wasInProgress && isInProgress && after.processingStatus === "new" && after.courierStage === "unbooked" && !ourSyncInFlight) {
    await db
      .update(orders)
      .set({ callingStatus: "confirmed", processingStatus: "in_progress", confirmedAt: now, shopifySyncStatus: "synced", shopifySyncedAt: now })
      .where(eq(orders.id, after.id));
    await log("confirmed", "Marked In progress in Shopify");
    const { scheduleAutoBook } = await import("./autobook");
    await scheduleAutoBook(db, after.id);
    await logActivity(db, "shopify", "calling.confirmed", { entityType: "order", entityId: after.id, orderId: after.id, details: { source: "shopify" } });
    return;
  }

  // Moved back to Unfulfilled in Shopify before booking → needs a new confirmation call.
  if (wasInProgress && after.shopifyFulfillmentStatus === "unfulfilled" && after.processingStatus === "in_progress" && after.courierStage === "unbooked" && !ourSyncInFlight) {
    await db
      .update(orders)
      .set({ callingStatus: "call_again", processingStatus: "new", confirmedAt: null, confirmedBy: null, shopifySyncStatus: "none" })
      .where(and(eq(orders.id, after.id)));
    await log("call_again", "Changed back to Unfulfilled in Shopify");
    const { cancelAutoBook } = await import("./autobook");
    await cancelAutoBook(db, after.id, "Changed back to Unfulfilled in Shopify");
    await logActivity(db, "shopify", "calling.reverted_in_shopify", { entityType: "order", entityId: after.id, orderId: after.id });
  }
}
