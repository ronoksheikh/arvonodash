import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { DB } from "../db";
import { consignments, customers, customStatuses, orders } from "../db/schema";
import type { NormalizedOrder } from "./shopify";
import type { AppSettings } from "./settings";
import { cleanPhone, normalizeBdPhone, nowIso } from "../lib/util";
import { applyShopifySideChanges } from "./calling";

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
  or exists (select 1 from json_each(coalesce(${orders.riskFlags}, '[]')) where value = 'changed_after_booking')
  or ${orders.courierStage} in ('issue', 'on_hold')
  or ${orders.fulfillmentState} = 'failed'
  or ${orders.shopifySyncStatus} = 'failed'
  or (${orders.cancelledAt} is not null and ${orders.courierStage} in ('booked', 'in_transit', 'on_hold'))
)`;
