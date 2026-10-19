import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { DB } from "../db";
import { consignments, customers, customStatuses, orders } from "../db/schema";
import type { NormalizedOrder } from "./shopify";
import { getSettings, type AppSettings } from "./settings";
import { logActivity } from "./activity";
import { classifyChannel, creditedVisit, type Attribution } from "../../shared/attribution";
import type { SessionUser } from "../env";
import { cleanPhone, normalizeBdPhone, nowIso } from "../lib/util";
import { applyShopifySideChanges } from "./calling";
import { newTrackingToken } from "./tracking";
import { getFraudCheck, judgeFraud, queueFraudCheck } from "./fraud";

/** Shopify's journey (read later) beats the webhook's landing page; a GraphQL import brings none. */
function pickAttribution(existing: Attribution | null, incoming: Attribution | undefined): Attribution | null {
  if (!incoming || existing?.from === "journey") return existing;
  if (incoming.from === "none" && existing) return existing;
  return incoming;
}

/** Columns for the order's source: channel and the credited (last-click) UTM tags. */
export function orderSource(sourceName: string | null, attribution: Attribution | null) {
  const visit = creditedVisit(attribution);
  return {
    attribution,
    channel: classifyChannel({ sourceName, visit }),
    utmSource: visit?.utm?.source ?? null,
    utmMedium: visit?.utm?.medium ?? null,
    utmCampaign: visit?.utm?.campaign ?? null,
  };
}

/** Insert or update an order from Shopify. Internal workflow fields are never overwritten. */
export async function upsertOrder(db: DB, input: NormalizedOrder, appSettings: AppSettings) {
  let o = input;
  const existing = await db.select().from(orders).where(eq(orders.shopifyId, o.shopifyId)).get();
  // Ignore stale deliveries (webhooks can arrive out of order).
  if (existing && existing.shopUpdatedAt > o.shopUpdatedAt) return { id: existing.id, created: false, stale: true };

  // REST webhook payloads only know unfulfilled/partial/fulfilled; keep finer GraphQL states such as
  // "in_progress" or "on_hold" until a GraphQL refresh says otherwise.
  if (existing && o.source === "rest" && o.shopifyFulfillmentStatus === "unfulfilled" && existing.shopifyFulfillmentStatus && !["fulfilled", "partial", "partially_fulfilled"].includes(existing.shopifyFulfillmentStatus)) {
    o = { ...o, shopifyFulfillmentStatus: existing.shopifyFulfillmentStatus };
  }
  const phone = normalizeBdPhone(o.rawPhone);
  const customerId = await upsertCustomer(db, {
    phone: phone ?? cleanPhone(o.rawPhone),
    name: o.customerName,
    email: o.email,
    shopifyCustomerId: o.shopifyCustomerId,
  });
  const now = nowIso();
  const data = {
    name: o.name,
    orderNumber: o.orderNumber,
    shopCreatedAt: o.shopCreatedAt,
    shopUpdatedAt: o.shopUpdatedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    closedAt: o.closedAt,
    customerId,
    shopifyCustomerId: o.shopifyCustomerId,
    customerName: o.customerName,
    phone: phone,
    rawPhone: o.rawPhone,
    email: o.email,
    address1: o.address1,
    address2: o.address2,
    city: o.city,
    province: o.province,
    zip: o.zip,
    country: o.country,
    currency: o.currency,
    subtotal: o.subtotal,
    shippingTotal: o.shippingTotal,
    discountTotal: o.discountTotal,
    total: o.total,
    outstanding: o.outstanding,
    financialStatus: o.financialStatus,
    shopifyFulfillmentStatus: o.shopifyFulfillmentStatus,
    paymentGateways: o.paymentGateways,
    shippingMethod: o.shippingMethod,
    lineItems: o.lineItems,
    shopifyTags: o.shopifyTags,
    shopifyNote: o.shopifyNote,
    noteAttributes: o.noteAttributes,
    sourceName: o.sourceName,
    ...orderSource(o.sourceName, pickAttribution(existing?.attribution ?? null, o.attribution)),
    updatedAt: now,
  };

  let id: number;
  if (existing) {
    await db.update(orders).set(data).where(eq(orders.id, existing.id));
    id = existing.id;
    // Orders fulfilled directly in Shopify should not be fulfilled again by us.
    if (existing.fulfillmentState === "none" && o.shopifyFulfillmentStatus === "fulfilled") {
      await db.update(orders).set({ fulfillmentState: "skipped" }).where(eq(orders.id, id));
    }
  } else {
    const defaultStatus = await db.select({ id: customStatuses.id }).from(customStatuses).where(eq(customStatuses.isDefault, true)).get();
    const row = await db
      .insert(orders)
      .values({
        ...data,
        shopifyId: o.shopifyId,
        statusId: defaultStatus?.id ?? null,
        trackingToken: newTrackingToken(),
        fulfillmentState: o.shopifyFulfillmentStatus === "fulfilled" ? "skipped" : "none",
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: orders.id })
      .get();
    if (!row) {
      // Lost a race with a concurrent insert of the same order.
      const again = await db.select({ id: orders.id }).from(orders).where(eq(orders.shopifyId, o.shopifyId)).get();
      return { id: again!.id, created: false, stale: false };
    }
    id = row.id;
  }
  await refreshRiskFlags(db, id, appSettings);
  const after = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (after) await applyShopifySideChanges(db, existing, after);
  if (o.shipments.length || after?.shopifyFulfillmentStatus === "fulfilled") {
    const { linkFromShopifyFulfillment } = await import("./legacy");
    await linkFromShopifyFulfillment(db, id, o.shipments);
  }
  // New live order (not a historical import): look the customer up in Steadfast's fraud check.
  if (!existing && after && !after.cancelledAt && after.courierStage === "unbooked" && Date.now() - Date.parse(after.shopCreatedAt) < 3 * 86_400_000) {
    await queueFraudCheck(db, after.phone);
    // "Thanks for your order" only for orders that just arrived, never for a historical import.
    if (Date.now() - Date.parse(after.shopCreatedAt) < 6 * 3_600_000) {
      const { queueSms } = await import("./sms");
      await queueSms(db, id, "placed", appSettings);
    }
  }
  return { id, created: !existing, stale: false };
}

async function upsertCustomer(
  db: DB,
  c: { phone: string | null; name: string | null; email: string | null; shopifyCustomerId: string | null },
): Promise<number | null> {
  if (!c.phone) return null;
  const now = nowIso();
  const row = await db
    .insert(customers)
    .values({ phone: c.phone, name: c.name, email: c.email, shopifyCustomerId: c.shopifyCustomerId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: customers.phone,
      set: {
        name: sql`coalesce(excluded.name, ${customers.name})`,
        email: sql`coalesce(excluded.email, ${customers.email})`,
        shopifyCustomerId: sql`coalesce(excluded.shopify_customer_id, ${customers.shopifyCustomerId})`,
        updatedAt: now,
      },
    })
    .returning({ id: customers.id })
    .get();
  return row?.id ?? null;
}

/** Delivery history for a phone number, from our own consignment records. */
export async function customerHistory(db: DB, customerId: number) {
  const row = await db
    .select({
      orders: sql<number>`count(distinct ${orders.id})`,
      delivered: sql<number>`count(distinct case when ${consignments.stage} in ('delivered','partial_delivered') then ${orders.id} end)`,
      returned: sql<number>`count(distinct case when ${consignments.stage} = 'returned' then ${orders.id} end)`,
      cancelledOrders: sql<number>`count(distinct case when ${orders.cancelledAt} is not null then ${orders.id} end)`,
      spent: sql<number>`coalesce(sum(case when ${consignments.stage} = 'delivered' then ${consignments.collectedAmount} end), 0)`,
    })
    .from(orders)
    .leftJoin(consignments, eq(consignments.orderId, orders.id))
    .where(eq(orders.customerId, customerId))
    .get();
  const finished = (row?.delivered ?? 0) + (row?.returned ?? 0);
  return {
    orders: row?.orders ?? 0,
    delivered: row?.delivered ?? 0,
    returned: row?.returned ?? 0,
    cancelledOrders: row?.cancelledOrders ?? 0,
    collected: row?.spent ?? 0,
    successRate: finished ? Math.round(((row?.delivered ?? 0) / finished) * 100) : null,
  };
}

/** Detects duplicate, suspicious and risky orders. Flags are advisory; staff can dismiss them. */
export async function refreshRiskFlags(db: DB, orderId: number, appSettings: AppSettings) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return;
  const flags: string[] = [];
  let duplicateOf: number | null = null;

  if (!order.phone) flags.push("invalid_phone");

  if (order.phone) {
    const windowMs = appSettings.duplicateWindowHours * 3_600_000;
    const from = new Date(new Date(order.shopCreatedAt).getTime() - windowMs).toISOString();
    const to = new Date(new Date(order.shopCreatedAt).getTime() + windowMs).toISOString();
    const others = await db
      .select({ id: orders.id, lineItems: orders.lineItems, shopCreatedAt: orders.shopCreatedAt })
      .from(orders)
      .where(
        and(
          eq(orders.phone, order.phone),
          ne(orders.id, order.id),
          isNull(orders.cancelledAt),
          gte(orders.shopCreatedAt, from),
          sql`${orders.shopCreatedAt} <= ${to}`,
        ),
      )
      .orderBy(orders.shopCreatedAt)
      .all();
    if (others.length) {
      flags.push("duplicate_recent");
      duplicateOf = others.find((x) => x.shopCreatedAt < order.shopCreatedAt)?.id ?? null;
      // Same key for webhook (REST) and imported (GraphQL) orders.
      const key = (items: { title: string; variantTitle?: string | null; sku?: string | null }[]) =>
        items.map((i) => `${i.title}|${i.variantTitle ?? ""}|${i.sku ?? ""}`).sort().join("||");
      const mine = key(order.lineItems);
      if (others.some((x) => key(x.lineItems) === mine)) flags.push("duplicate_items");
    }
  }

  const address = `${order.address1 ?? ""} ${order.address2 ?? ""}`.trim();
  if (address.length < 10) flags.push("short_address");
  if (order.outstanding >= appSettings.highValueThreshold) flags.push("high_value");
  if (order.lineItems.reduce((s, li) => s + li.quantity, 0) >= 10) flags.push("large_quantity");
  if (/\btest\b/i.test(`${order.customerName ?? ""} ${order.email ?? ""} ${order.address1 ?? ""}`)) flags.push("test_order");

  if (order.customerId) {
    const customer = await db.select({ flag: customers.flag }).from(customers).where(eq(customers.id, order.customerId)).get();
    if (customer?.flag === "blocked") flags.push("blocked_customer");
    if (customer?.flag === "risky") flags.push("risky_customer");
    const h = await customerHistory(db, order.customerId);
    const finished = h.delivered + h.returned;
    if (finished >= 2 && h.returned / finished >= 0.5) flags.push("high_return_rate");
  }

  // Steadfast fraud check (cached per phone; looked up by the job queue when the order arrives).
  if (order.phone && order.courierStage === "unbooked") {
    const fraud = await getFraudCheck(db, order.phone);
    if (fraud?.status === "ok" && judgeFraud({ ...fraud, volumeBand: fraud.volumeBand ?? "none" }, appSettings).verdict === "risky") flags.push("courier_fraud");
  }

  // Parcel problems after booking (only the order that owns the parcel carries them).
  if (order.activeConsignmentId && !order.combinedIntoOrderId) {
    const c = await db.select().from(consignments).where(eq(consignments.id, order.activeConsignmentId)).get();
    if (c && !c.isFinal) {
      const group = await db.select({ outstanding: orders.outstanding, cancelledAt: orders.cancelledAt, combinedInto: orders.combinedIntoOrderId }).from(orders).where(eq(orders.activeConsignmentId, c.id)).all();
      if (c.codChangedFrom !== null && Math.abs(c.codAmount - group.reduce((s, o) => s + o.outstanding, 0)) > 1) flags.push("cod_mismatch");
      if (group.some((o) => o.combinedInto && o.cancelledAt)) flags.push("combined_order_cancelled");
    }
  }

  // Deleted in Shopify while the parcel is still live: someone has to stop it at Steadfast.
  if (order.shopifyDeletedAt && order.courierStage !== "unbooked" && !["delivered", "partial_delivered", "returned", "cancelled"].includes(order.courierStage)) {
    flags.push("deleted_in_shopify");
  }

  // Shopify edits (admin or mobile app) after booking: the courier still has the old details.
  if (order.bookedSource && !["delivered", "partial_delivered", "returned", "cancelled"].includes(order.courierStage) && order.bookedSource !== shopifyContactKey(order)) {
    flags.push("changed_after_booking");
  }
  await db.update(orders).set({ riskFlags: flags, duplicateOfOrderId: duplicateOf }).where(eq(orders.id, order.id));
}

export function buildAddress(o: { address1: string | null; address2: string | null; city: string | null; province?: string | null; zip: string | null }): string {
  const parts = [o.address1, o.address2, o.city, o.zip].map((p) => (p ?? "").trim()).filter(Boolean);
  // Remove consecutive duplicates such as "Dhaka, Dhaka".
  const deduped = parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase());
  return deduped.join(", ");
}

/** Snapshot of the Shopify contact details a booking was made from, to detect later edits in Shopify. */
export function shopifyContactKey(o: { rawPhone: string | null; address1: string | null; address2: string | null; city: string | null; zip: string | null }) {
  return [o.rawPhone ?? "", buildAddress({ ...o, province: null })].join("|");
}

/** Orders that need a human: unreviewed flags, courier issues, failed syncs, cancellations after booking. */
export const ATTENTION_SQL = sql`(
  (json_array_length(coalesce(${orders.riskFlags}, '[]')) > 0 and ${orders.riskDismissed} = 0 and ${orders.courierStage} = 'unbooked' and ${orders.cancelledAt} is null)
  or exists (select 1 from json_each(coalesce(${orders.riskFlags}, '[]')) where value in ('changed_after_booking', 'cod_mismatch', 'combined_order_cancelled', 'deleted_in_shopify'))
  or ${orders.courierStage} in ('issue', 'on_hold')
  or ${orders.fulfillmentState} = 'failed'
  or ${orders.shopifySyncStatus} = 'failed'
  or (${orders.cancelledAt} is not null and ${orders.courierStage} in ('booked', 'in_transit', 'on_hold', 'awaiting_confirmation'))
)`;

/**
 * The order no longer exists in Shopify (deleted in the admin or app). It is treated as cancelled
 * everywhere (no booking, no printing, scanner says STOP, pickup says pull it out). Without a live
 * parcel it is archived; with one it stays visible, flagged, until the parcel is stopped.
 */
export async function markDeletedInShopify(db: DB, shopifyId: string, actor: "shopify" | "system" | SessionUser = "shopify") {
  const order = await db.select().from(orders).where(eq(orders.shopifyId, shopifyId)).get();
  if (!order || order.shopifyDeletedAt) return null;
  const now = nowIso();
  const liveParcel = order.courierStage !== "unbooked" && !["delivered", "partial_delivered", "returned", "cancelled"].includes(order.courierStage);
  await db
    .update(orders)
    .set({
      shopifyDeletedAt: now,
      cancelledAt: order.cancelledAt ?? now,
      cancelReason: order.cancelReason ?? "deleted",
      processingStatus: "cancelled",
      shopifySyncStatus: "none",
      autoBookAt: null,
      autoBookNote: "Order deleted in Shopify",
      archived: !liveParcel,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id));
  const { onNotPrintable } = await import("./dispatch");
  await onNotPrintable(db, order.id, "Order deleted in Shopify", { name: typeof actor === "object" ? actor.name : actor });
  await refreshRiskFlags(db, order.id, await getSettings(db));
  await logActivity(db, actor, "order.deleted_in_shopify", { entityType: "order", entityId: order.id, orderId: order.id, details: { courierStage: order.courierStage, liveParcel } });
  return { id: order.id, liveParcel };
}
