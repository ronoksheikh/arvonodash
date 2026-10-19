import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb, inList, pick, type DB } from "../db";
import { activityLog, callLogs, consignments, customers, customStatuses, fraudChecks, orderNotes, orders, returns, trackingEvents, users, type BookingDetails } from "../db/schema";
import { requirePerm } from "../lib/auth";
import { csvEscape, nowIso, normalizeBdPhone } from "../lib/util";
import { CHANNELS, creditedVisit, type Channel } from "../../shared/attribution";
import { getSettings } from "../services/settings";
import { logActivity } from "../services/activity";
import { bookOrders, defaultBooking, effectiveBooking, queueFulfillment, validateBooking } from "../services/courier";
import { ATTENTION_SQL, customerHistory, markDeletedInShopify, refreshRiskFlags, upsertOrder } from "../services/orders";
import { CANCEL_REASONS, cancelOrder, closeOrder, deleteOrder, fetchOrder, shopifyAdminOrderUrl } from "../services/shopify";
import { setCallingStatus } from "../services/calling";
import { orderHistory } from "../services/dispatch";
import { processJobs } from "../services/jobs";
import { trackingUrl } from "../services/steadfast";
import { NOTE_KINDS } from "../../shared/constants";
import { partialOutcome } from "../../shared/delivery";
import { ensureTrackingToken, publicTrackingUrl } from "../services/tracking";
import { buildJourney } from "../services/journey";
import { sendManualSms, smsLog } from "../services/sms";
import { ensureFraudCheck, fraudSummary, getFraudCheck, RISKY_FRAUD_SQL, type FraudRow } from "../services/fraud";
import { openSiblings } from "../services/autobook";

export const orderRoutes = new Hono<AppEnv>();

const TABS = ["all", "call_first", "to_call", "ready", "booked", "in_transit", "delivered", "returned", "cancelled", "attention"] as const;



// Orders fulfilled in Shopify outside ARVONO never belong in the calling/booking queues.
const NOT_FULFILLED = sql`coalesce(${orders.shopifyFulfillmentStatus}, '') not in ('fulfilled', 'partially_fulfilled', 'partial')`;

function tabCondition(tab: string): SQL | undefined {
  switch (tab) {
    case "call_first": // Steadfast fraud check says risky: call before anything is booked
      return and(eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt), eq(orders.riskDismissed, false), NOT_FULFILLED, RISKY_FRAUD_SQL);
    case "to_call":
      return and(inArray(orders.callingStatus, ["not_called", "no_answer", "call_again"]), eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt), NOT_FULFILLED);
    case "ready":
      return and(eq(orders.callingStatus, "confirmed"), eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt), NOT_FULFILLED);
    case "booked":
      return eq(orders.courierStage, "booked");
    case "in_transit":
      return inArray(orders.courierStage, ["in_transit", "on_hold", "awaiting_confirmation"]);
    case "delivered":
      return inArray(orders.courierStage, ["delivered", "partial_delivered"]);
    case "returned":
      return eq(orders.courierStage, "returned");
    case "cancelled":
      return or(isNotNull(orders.cancelledAt), eq(orders.courierStage, "cancelled"));
    case "attention":
      return ATTENTION_SQL;
    default:
      return undefined;
  }
}

function filterConditions(q: Record<string, string | undefined>): SQL[] {
  const conds: SQL[] = [eq(orders.archived, q.archived === "1")];
  const search = q.search?.trim();
  if (search) {
    const like = `%${search.replace(/[%_]/g, "")}%`;
    const phone = normalizeBdPhone(search);
    conds.push(
      or(
        sql`${orders.name} like ${like}`,
        sql`${orders.customerName} like ${like}`,
        sql`${orders.phone} like ${phone ? `%${phone}%` : like}`,
        sql`${orders.rawPhone} like ${like}`,
        sql`${orders.email} like ${like}`,
        sql`${orders.address1} like ${like}`,
        sql`${orders.id} in (select order_id from consignments where tracking_code like ${like} or consignment_id like ${like} or invoice like ${like})`,
      )!,
    );
  }
  if (q.calling) conds.push(inArray(orders.callingStatus, q.calling.split(",")));
  if (q.label) conds.push(inArray(orders.labelStatus, q.label.split(",")));
  if (q.dispatch) conds.push(inArray(orders.dispatchStatus, q.dispatch.split(",")));
  if (q.statusId) conds.push(q.statusId === "none" ? isNull(orders.statusId) : eq(orders.statusId, Number(q.statusId)));
  if (q.stage) conds.push(inArray(orders.courierStage, q.stage.split(",")));
  if (q.fulfillment) conds.push(inArray(orders.fulfillmentState, q.fulfillment.split(",")));
  if (q.financial) conds.push(inArray(orders.financialStatus, q.financial.split(",")));
  if (q.flagged === "1") conds.push(and(sql`json_array_length(coalesce(${orders.riskFlags}, '[]')) > 0`, eq(orders.riskDismissed, false))!);
  if (q.tag) conds.push(sql`exists (select 1 from json_each(coalesce(${orders.internalTags}, '[]')) where value = ${q.tag})`);
  if (q.from) conds.push(gte(orders.shopCreatedAt, q.from));
  if (q.to) conds.push(lte(orders.shopCreatedAt, q.to));
  if (q.customerId) conds.push(eq(orders.customerId, Number(q.customerId)));
  if (q.channel) {
    const list = q.channel.split(",");
    // Orders not read yet have no channel; they count as unknown.
    conds.push(list.includes("unknown") ? or(inArray(orders.channel, list), isNull(orders.channel))! : inArray(orders.channel, list));
  }
  if (q.campaign) conds.push(q.campaign === "none" ? isNull(orders.utmCampaign) : eq(orders.utmCampaign, q.campaign));
  if (q.ids) conds.push(inList(orders.id, q.ids.split(",").map(Number).filter(Boolean)));
  return conds;
}

const SORTS = {
  created: orders.shopCreatedAt,
  total: orders.total,
  name: orders.orderNumber,
  customer: orders.customerName,
  updated: orders.updatedAt,
} as const;

const listColumns = {
  id: orders.id,
  shopifyId: orders.shopifyId,
  name: orders.name,
  shopCreatedAt: orders.shopCreatedAt,
  customerName: orders.customerName,
  phone: orders.phone,
  rawPhone: orders.rawPhone,
  city: orders.city,
  address1: orders.address1,
  total: orders.total,
  outstanding: orders.outstanding,
  currency: orders.currency,
  financialStatus: orders.financialStatus,
  shopifyFulfillmentStatus: orders.shopifyFulfillmentStatus,
  cancelledAt: orders.cancelledAt,
  statusId: orders.statusId,
  internalTags: orders.internalTags,
  riskFlags: orders.riskFlags,
  riskDismissed: orders.riskDismissed,
  courierStage: orders.courierStage,
  fulfillmentState: orders.fulfillmentState,
  fulfillmentError: orders.fulfillmentError,
  callingStatus: orders.callingStatus,
  callAttempts: orders.callAttempts,
  callbackAt: orders.callbackAt,
  processingStatus: orders.processingStatus,
  shopifySyncStatus: orders.shopifySyncStatus,
  labelStatus: orders.labelStatus,
  dispatchStatus: orders.dispatchStatus,
  cancelRequestedAt: orders.cancelRequestedAt,
  autoBookAt: orders.autoBookAt,
  autoBookNote: orders.autoBookNote,
  combinedIntoOrderId: orders.combinedIntoOrderId,
  customerId: orders.customerId,
  channel: orders.channel,
  utmSource: orders.utmSource,
  utmMedium: orders.utmMedium,
  utmCampaign: orders.utmCampaign,
  // Same customer's other confirmed orders still waiting for a parcel (can travel together).
  combinableWith: sql<string | null>`(select group_concat(o3.name, ', ') from orders o3 where o3.phone = ${orders.phone} and o3.id != ${orders.id}
    and o3.courier_stage = 'unbooked' and o3.calling_status = 'confirmed' and o3.cancelled_at is null and o3.archived = 0
    and o3.active_consignment_id is null and o3.combined_into_order_id is null)`,
  // Customer history (all their orders, by phone), for "new vs returning" at a glance.
  customerOrders: sql<number>`(select count(*) from orders o2 where o2.customer_id = ${orders.customerId} and o2.id != ${orders.id})`,
  customerDelivered: sql<number>`(select count(*) from orders o2 where o2.customer_id = ${orders.customerId} and o2.id != ${orders.id} and o2.courier_stage in ('delivered','partial_delivered'))`,
  customerReturned: sql<number>`(select count(*) from orders o2 where o2.customer_id = ${orders.customerId} and o2.id != ${orders.id} and o2.courier_stage = 'returned')`,
  customerFlag: sql<string | null>`(select flag from customers c2 where c2.id = ${orders.customerId})`,
  itemCount: sql<number>`(select coalesce(sum(json_extract(value, '$.quantity')), 0) from json_each(${orders.lineItems}))`,
  trackingCode: consignments.trackingCode,
  consignmentStatus: consignments.status,
  consignmentCod: consignments.codAmount,
};

orderRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const tab = TABS.includes(q.tab as (typeof TABS)[number]) ? q.tab! : "all";
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));
  const base = filterConditions(q);
  const where = and(...base, tabCondition(tab));
  const sortCol = SORTS[(q.sort as keyof typeof SORTS) ?? "created"] ?? orders.shopCreatedAt;
  const order = q.dir === "asc" ? asc(sortCol) : desc(sortCol);

  const [rows, total, tabCounts] = await Promise.all([
    db
      .select(listColumns)
      .from(orders)
      .leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId))
      .where(where)
      .orderBy(order, desc(orders.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all(),
    db.select({ n: sql<number>`count(*)` }).from(orders).where(where).get(),
    Promise.all(
      TABS.map(async (t) => [t, (await db.select({ n: sql<number>`count(*)` }).from(orders).where(and(...base, tabCondition(t))).get())?.n ?? 0] as const),
    ),
  ]);
  const appSettings = await getSettings(db);
  const fraud = await fraudByPhone(db, rows.map((r) => r.phone));
  return c.json({
    rows: rows.map((r) => ({ ...r, fraud: r.phone ? fraudSummary(fraud.get(r.phone) ?? null, appSettings) : null })),
    total: total?.n ?? 0,
    page,
    pageSize,
    tabCounts: Object.fromEntries(tabCounts),
  });
});

/**
 * Each order with its active parcel. Read in two queries, not a join: the orders table alone is close
 * to D1's 100-column limit for one result row.
 */
async function withActiveConsignment(db: ReturnType<typeof getDb>, list: (typeof orders.$inferSelect)[]) {
  const ids = list.map((o) => o.activeConsignmentId).filter((x): x is number => x !== null);
  const parcels = new Map<number, Pick<typeof consignments.$inferSelect, "consignmentId" | "trackingCode" | "status" | "codAmount" | "collectedAmount" | "deliveryCharge" | "paymentId" | "invoice" | "note">>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = await db
      .select({ ...pick(consignments, ["consignmentId", "trackingCode", "status", "codAmount", "collectedAmount", "deliveryCharge", "paymentId", "invoice", "note"]), rowId: consignments.id })
      .from(consignments)
      .where(inList(consignments.id, ids.slice(i, i + 500)))
      .all();
    for (const { rowId, ...c } of chunk) parcels.set(rowId, c);
  }
  return list.map((o) => ({ o, c: o.activeConsignmentId ? (parcels.get(o.activeConsignmentId) ?? null) : null }));
}

/** Channels and campaigns seen in the last 90 days, for the Source filter. */
orderRoutes.get("/sources", async (c) => {
  const db = getDb(c.env.DB);
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const [channels, campaigns] = await Promise.all([
    db.select({ channel: orders.channel, n: sql<number>`count(*)` }).from(orders).where(and(gte(orders.shopCreatedAt, since), eq(orders.archived, false))).groupBy(orders.channel).orderBy(sql`count(*) desc`).all(),
    db
      .select({ campaign: orders.utmCampaign, channel: sql<string>`max(${orders.channel})`, n: sql<number>`count(*)` })
      .from(orders)
      .where(and(gte(orders.shopCreatedAt, since), eq(orders.archived, false), isNotNull(orders.utmCampaign)))
      .groupBy(orders.utmCampaign)
      .orderBy(sql`count(*) desc`)
      .limit(100)
      .all(),
  ]);
  return c.json({ channels: channels.map((x) => ({ channel: x.channel ?? "unknown", count: Number(x.n) })), campaigns: campaigns.map((x) => ({ ...x, n: undefined, count: Number(x.n) })) });
});

orderRoutes.get("/export.csv", requirePerm("export"), async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const where = and(...filterConditions(q), tabCondition(q.tab ?? "all"));
  const statuses = new Map((await db.select().from(customStatuses).all()).map((s) => [s.id, s.name]));
  const rows = await withActiveConsignment(db, await db.select().from(orders).where(where).orderBy(desc(orders.shopCreatedAt)).limit(10_000).all());
  const header = [
    "Order", "Created", "Calling", "Processing", "Customer", "Phone", "Address", "City", "Items", "Total", "COD due", "Payment", "Shopify fulfillment",
    "Status", "Tags", "Courier stage", "Consignment ID", "Tracking code", "Steadfast status", "COD booked", "Collected", "Delivery charge",
    "Fulfillment", "Label", "Dispatch", "Settled payment", "Risk flags", "Source", "UTM source", "UTM medium", "UTM campaign", "UTM content", "Referrer", "Landing page",
  ];
  const lines = [header.join(",")];
  for (const { o, c: cn } of rows) {
    lines.push(
      [
        o.name, o.shopCreatedAt, o.callingStatus, o.processingStatus, o.customerName, o.phone ?? o.rawPhone, [o.address1, o.address2].filter(Boolean).join(", "), o.city,
        o.lineItems.map((li) => `${li.quantity}x ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ""}`).join("; "),
        o.total, o.outstanding, o.financialStatus, o.shopifyFulfillmentStatus, o.statusId ? statuses.get(o.statusId) : "",
        (o.internalTags ?? []).join("; "), o.courierStage, cn?.consignmentId, cn?.trackingCode, cn?.status, cn?.codAmount,
        cn?.collectedAmount, cn?.deliveryCharge, o.fulfillmentState, o.labelStatus, o.dispatchStatus, cn?.paymentId, o.riskDismissed ? "" : (o.riskFlags ?? []).join("; "),
        o.channel ? CHANNELS[o.channel as Channel]?.label ?? o.channel : "", o.utmSource, o.utmMedium, o.utmCampaign,
        creditedVisit(o.attribution)?.utm?.content, creditedVisit(o.attribution)?.referrerUrl, creditedVisit(o.attribution)?.landingPage,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  await logActivity(db, c.get("user"), "orders.exported", { details: { count: rows.length, tab: q.tab ?? "all" } });
  return new Response("﻿" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

/** Data for packing slips and shipping labels. */
orderRoutes.get("/print", requirePerm("export"), async (c) => {
  const db = getDb(c.env.DB);
  const ids = (c.req.query("ids") ?? "").split(",").map(Number).filter(Boolean).slice(0, 500);
  const appSettings = await getSettings(db);
  const rows = await withActiveConsignment(db, await db.select().from(orders).where(inList(orders.id, ids)).all());
  const byId = new Map(rows.map((r) => [r.o.id, r]));
  return c.json({
    business: { name: appSettings.businessName, phone: appSettings.businessPhone, address: appSettings.businessAddress },
    orders: ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((r) => ({
        id: r!.o.id,
        name: r!.o.name,
        createdAt: r!.o.shopCreatedAt,
        lineItems: r!.o.lineItems,
        subtotal: r!.o.subtotal,
        shipping: r!.o.shippingTotal,
        discount: r!.o.discountTotal,
        total: r!.o.total,
        booking: effectiveBooking(r!.o, appSettings),
        shopifyNote: r!.o.shopifyNote,
        consignment: r!.c ? { consignmentId: r!.c.consignmentId, trackingCode: r!.c.trackingCode, codAmount: r!.c.codAmount, invoice: r!.c.invoice, note: r!.c.note } : null,
      })),
  });
});

async function fraudByPhone(db: DB, phones: (string | null)[]) {
  const list = [...new Set(phones.filter((p): p is string => Boolean(p)))];
  const rows: FraudRow[] = list.length ? await db.select().from(fraudChecks).where(inList(fraudChecks.phone, list)).all() : [];
  return new Map(rows.map((r) => [r.phone, r]));
}

async function loadOrder(db: DB, id: number) {
  const order = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return null;
  return order;
}

/** Pull the latest from Shopify now (dashboard load/refresh). Throttled server-side. */
orderRoutes.post("/sync-now", async (c) => {
  const db = getDb(c.env.DB);
  const { quickSync } = await import("../services/sync");
  return c.json(await quickSync(c.env, db));
});

orderRoutes.get("/:id{[0-9]+}", async (c) => {
  const db = getDb(c.env.DB);
  const order = await loadOrder(db, Number(c.req.param("id")));
  if (!order) return c.json({ error: "Order not found" }, 404);
  const appSettings = await getSettings(db);
  const [calls, dispatchHistory] = await Promise.all([
    db.select().from(callLogs).where(eq(callLogs.orderId, order.id)).orderBy(desc(callLogs.createdAt), desc(callLogs.id)).all(),
    orderHistory(db, order.id),
  ]);
  const [customer, history, cons, events, notes, activity, rets, duplicates] = await Promise.all([
    order.customerId ? db.select().from(customers).where(eq(customers.id, order.customerId)).get() : null,
    order.customerId ? customerHistory(db, order.customerId) : null,
    // Include the parcel this order travels in when it was combined into another order's booking.
    db
      .select()
      .from(consignments)
      .where(or(eq(consignments.orderId, order.id), order.activeConsignmentId ? eq(consignments.id, order.activeConsignmentId) : undefined))
      .orderBy(desc(consignments.createdAt))
      .all(),
    db
      .select()
      .from(trackingEvents)
      .where(or(eq(trackingEvents.orderId, order.id), order.activeConsignmentId ? eq(trackingEvents.consignmentRowId, order.activeConsignmentId) : undefined))
      .orderBy(desc(trackingEvents.occurredAt), desc(trackingEvents.id))
      .all(),
    db
      .select({ note: orderNotes, userName: users.name })
      .from(orderNotes)
      .leftJoin(users, eq(users.id, orderNotes.userId))
      .where(eq(orderNotes.orderId, order.id))
      .orderBy(desc(orderNotes.createdAt))
      .all(),
    db.select().from(activityLog).where(eq(activityLog.orderId, order.id)).orderBy(desc(activityLog.createdAt)).limit(100).all(),
    db.select().from(returns).where(eq(returns.orderId, order.id)).all(),
    order.phone
      ? db
          .select({ id: orders.id, name: orders.name, shopCreatedAt: orders.shopCreatedAt, total: orders.total, courierStage: orders.courierStage, cancelledAt: orders.cancelledAt })
          .from(orders)
          .where(and(eq(orders.phone, order.phone), sql`${orders.id} != ${order.id}`))
          .orderBy(desc(orders.shopCreatedAt))
          .limit(20)
          .all()
      : [],
  ]);
  return c.json({
    order,
    booking: effectiveBooking(order, appSettings),
    defaultBooking: defaultBooking(order, appSettings),
    customer,
    history,
    otherOrders: duplicates,
    consignments: cons.map((x) => ({
      ...x,
      trackingUrl: x.trackingCode ? trackingUrl(c.env, x.trackingCode) : null,
      partialOutcome: x.stage === "partial_delivered" ? partialOutcome(x.collectedAmount, order.lineItems) : null,
    })),
    fraud: fraudSummary(await getFraudCheck(db, order.phone), appSettings),
    // Orders sharing this order's parcel (combined booking), and confirmed orders that could join it.
    parcelOrders: order.activeConsignmentId
      ? await db
          .select({ id: orders.id, name: orders.name, total: orders.total, outstanding: orders.outstanding, combinedIntoOrderId: orders.combinedIntoOrderId, cancelledAt: orders.cancelledAt })
          .from(orders)
          .where(eq(orders.activeConsignmentId, order.activeConsignmentId))
          .all()
      : [],
    combineCandidates:
      order.courierStage === "unbooked" && order.callingStatus === "confirmed" && !order.cancelledAt
        ? (await openSiblings(db, order)).map((x) => ({ id: x.id, name: x.name, total: x.total, outstanding: x.outstanding, shopCreatedAt: x.shopCreatedAt, items: x.lineItems.length }))
        : [],
    events,
    notes: notes.map((n) => ({ ...n.note, userName: n.userName })),
    activity,
    returns: rets,
    calls,
    dispatchHistory,
    shopifyUrl: shopifyAdminOrderUrl(c.env, order.shopifyId),
    trackingPageUrl: await ensureTrackingToken(db, order.id).then((t) => (t ? publicTrackingUrl(db, appSettings, t, new URL(c.req.url).origin) : null)),
    journey: await buildJourney(db, order),
    sms: await smsLog(db, { orderId: order.id, limit: 50 }),
  });
});

/** Staff SMS to the order's customer: free text or a template, with {placeholders} filled in. */
orderRoutes.post("/:id{[0-9]+}/sms", requirePerm("sms.send"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ body?: string; template?: string; phone?: string }>();
  const user = c.get("user");
  const r = await sendManualSms(c.env, db, user, { orderId: id, body: body.body, template: (body.template as never) ?? null, phone: body.phone });
  await logActivity(db, user, "sms.manual", { entityType: "order", entityId: id, orderId: id, details: { phone: r.phone, segments: r.segments } });
  return c.json(r);
});

orderRoutes.patch("/:id{[0-9]+}", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ statusId?: number | null; internalTags?: string[]; customerRemark?: string | null; riskDismissed?: boolean; archived?: boolean }>();
  const order = await loadOrder(db, id);
  if (!order) return c.json({ error: "Order not found" }, 404);
  const patch: Partial<typeof orders.$inferInsert> = { updatedAt: nowIso() };
  if ("statusId" in body) patch.statusId = body.statusId ?? null;
  if (Array.isArray(body.internalTags)) patch.internalTags = [...new Set(body.internalTags.map((t) => t.trim()).filter(Boolean))].slice(0, 30);
  if ("customerRemark" in body) patch.customerRemark = body.customerRemark?.slice(0, 2000) ?? null;
  if (typeof body.riskDismissed === "boolean") patch.riskDismissed = body.riskDismissed;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  await db.update(orders).set(patch).where(eq(orders.id, id));
  await logActivity(db, c.get("user"), "order.updated", { entityType: "order", entityId: id, orderId: id, details: body });
  return c.json({ ok: true });
});

orderRoutes.put("/:id{[0-9]+}/booking", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const order = await loadOrder(db, id);
  if (!order) return c.json({ error: "Order not found" }, 404);
  const body = await c.req.json<{ booking: Partial<BookingDetails> | null }>();
  if (body.booking === null) {
    await db.update(orders).set({ booking: null }).where(eq(orders.id, id));
    return c.json({ ok: true });
  }
  const appSettings = await getSettings(db);
  const merged = { ...effectiveBooking(order, appSettings), ...body.booking } as BookingDetails;
  const errors = validateBooking(merged);
  if (errors.length) return c.json({ error: errors.join("; "), errors }, 400);
  const allowed: (keyof BookingDetails)[] = [
    "recipientName", "recipientPhone", "alternativePhone", "recipientEmail", "recipientAddress", "codAmount", "note", "itemDescription", "totalLot", "deliveryType", "lineItems",
  ];
  const saved = Object.fromEntries(allowed.filter((k) => k in body.booking!).map((k) => [k, body.booking![k]]));
  await db.update(orders).set({ booking: { ...(order.booking ?? {}), ...saved }, updatedAt: nowIso() }).where(eq(orders.id, id));
  await logActivity(db, c.get("user"), "order.booking_edited", { entityType: "order", entityId: id, orderId: id, details: saved });
  return c.json({ ok: true });
});

orderRoutes.post("/:id{[0-9]+}/notes", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ kind: string; body: string; rating?: number }>();
  if (!(body.kind in NOTE_KINDS) || !body.body?.trim()) return c.json({ error: "Note type and text are required" }, 400);
  const order = await loadOrder(db, id);
  if (!order) return c.json({ error: "Order not found" }, 404);
  const rating = body.kind === "customer_review" && body.rating ? Math.min(5, Math.max(1, Math.round(body.rating))) : null;
  await db.insert(orderNotes).values({
    orderId: id,
    customerId: order.customerId,
    kind: body.kind,
    body: body.body.trim().slice(0, 4000),
    rating,
    userId: c.get("user").id,
    createdAt: nowIso(),
  });
  // Rider instructions travel with the booking note sent to Steadfast.
  if (body.kind === "rider_instruction" && order.courierStage === "unbooked") {
    const note = [order.booking?.note, body.body.trim()].filter(Boolean).join(" | ").slice(0, 500);
    await db.update(orders).set({ booking: { ...(order.booking ?? {}), note } }).where(eq(orders.id, id));
  }
  await logActivity(db, c.get("user"), "order.note_added", { entityType: "order", entityId: id, orderId: id, details: { kind: body.kind } });
  return c.json({ ok: true });
});

orderRoutes.delete("/:id{[0-9]+}/notes/:noteId{[0-9]+}", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user");
  const note = await db.select().from(orderNotes).where(eq(orderNotes.id, Number(c.req.param("noteId")))).get();
  if (!note) return c.json({ error: "Note not found" }, 404);
  if (note.userId !== user.id && !["owner", "admin"].includes(user.role)) return c.json({ error: "Only the author or an admin can delete this note" }, 403);
  await db.delete(orderNotes).where(eq(orderNotes.id, note.id));
  return c.json({ ok: true });
});

orderRoutes.post("/bulk", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const { ids, action, value } = await c.req.json<{ ids: number[]; action: string; value?: string | number | null }>();
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) return c.json({ error: "Select between 1 and 500 orders" }, 400);
  const rows = await db.select({ id: orders.id, internalTags: orders.internalTags }).from(orders).where(inList(orders.id, ids)).all();
  const now = nowIso();
  switch (action) {
    case "set_status": {
      const statusId = value === null || value === "" ? null : Number(value);
      await db.update(orders).set({ statusId, updatedAt: now }).where(inList(orders.id, ids));
      break;
    }
    case "add_tag":
    case "remove_tag": {
      const tag = String(value ?? "").trim();
      if (!tag) return c.json({ error: "Tag is required" }, 400);
      for (const r of rows) {
        const tags = new Set(r.internalTags ?? []);
        if (action === "add_tag") tags.add(tag);
        else tags.delete(tag);
        await db.update(orders).set({ internalTags: [...tags], updatedAt: now }).where(eq(orders.id, r.id));
      }
      break;
    }
    case "dismiss_risk":
      await db.update(orders).set({ riskDismissed: true, updatedAt: now }).where(inList(orders.id, ids));
      break;
    case "archive":
    case "unarchive":
      await db.update(orders).set({ archived: action === "archive", updatedAt: now }).where(inList(orders.id, ids));
      break;
    default:
      return c.json({ error: "Unknown action" }, 400);
  }
  await logActivity(db, c.get("user"), `orders.bulk_${action}`, { details: { ids, value } });
  return c.json({ ok: true, updated: rows.length });
});

/** Manual booking only: orders are sent to Steadfast exclusively through this staff action. */
orderRoutes.post("/book", requirePerm("courier.book"), async (c) => {
  const db = getDb(c.env.DB);
  const { ids, override, allowRisky, combine } = await c.req.json<{ ids: number[]; override?: Partial<BookingDetails>; allowRisky?: boolean; combine?: boolean }>();
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: "No orders selected" }, 400);
  if (ids.length > 100) return c.json({ error: "Book at most 100 orders per request" }, 400);
  // Overrides edit one parcel: a single order, or one order plus the orders combined into it.
  if (override && ids.length > 1 && !combine) return c.json({ error: "Booking overrides apply to a single order" }, 400);
  if (override && combine) {
    const phones = new Set((await db.select({ phone: orders.phone }).from(orders).where(inList(orders.id, ids)).all()).map((r) => r.phone));
    if (phones.size !== 1) return c.json({ error: "Booking overrides apply to one parcel (one customer)" }, 400);
  }
  const results = await bookOrders(c.env, db, c.get("user"), ids, { override, allowRisky, combine: Boolean(combine) }, (p) => c.executionCtx.waitUntil(p));
  return c.json({ results, booked: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
});

/** Look the customer up in Steadfast's fraud check now (cached per phone; limits apply). */
orderRoutes.post("/:id{[0-9]+}/fraud-check", requirePerm("orders.view"), async (c) => {
  const db = getDb(c.env.DB);
  const order = await loadOrder(db, Number(c.req.param("id")));
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (!order.phone) return c.json({ error: "This order has no valid phone number to check" }, 400);
  const r = await ensureFraudCheck(c.env, db, order.phone, { force: true });
  const updated = await loadOrder(db, order.id);
  return c.json({ fraud: fraudSummary(r.row, await getSettings(db)), deferred: r.deferred, riskFlags: updated?.riskFlags ?? [] });
});

orderRoutes.post("/:id{[0-9]+}/fulfill", requirePerm("fulfillment.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const order = await loadOrder(db, id);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (!order.activeConsignmentId) return c.json({ error: "Order has no consignment to take tracking from" }, 400);
  const jobId = await queueFulfillment(db, id, order.activeConsignmentId, true);
  await logActivity(db, c.get("user"), "order.fulfillment_requested", { entityType: "order", entityId: id, orderId: id });
  if (jobId) await processJobs(c.env, db, { ids: [jobId] });
  const updated = await loadOrder(db, id);
  return c.json({ fulfillmentState: updated?.fulfillmentState, fulfillmentError: updated?.fulfillmentError });
});

orderRoutes.post("/:id{[0-9]+}/refresh", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const order = await loadOrder(db, id);
  if (!order) return c.json({ error: "Order not found" }, 404);
  const fresh = await fetchOrder(c.env, db, order.shopifyId);
  if (!fresh) return c.json({ error: "Order no longer exists in Shopify" }, 404);
  await upsertOrder(db, fresh, await getSettings(db));
  return c.json({ ok: true });
});

orderRoutes.post("/:id{[0-9]+}/recheck-risk", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  await refreshRiskFlags(db, id, await getSettings(db));
  await db.update(orders).set({ riskDismissed: false }).where(eq(orders.id, id));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Calling / verification

orderRoutes.post("/:id{[0-9]+}/calling", requirePerm("orders.call"), async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ status: string; note?: string; callbackAt?: string | null }>();
  const r = await setCallingStatus(db, c.get("user"), Number(c.req.param("id")), body);
  c.executionCtx.waitUntil(processJobs(c.env, db, { limit: 3 }));
  return c.json({ ok: true, ...r });
});

orderRoutes.post("/calling/bulk", requirePerm("orders.call"), async (c) => {
  const db = getDb(c.env.DB);
  const { ids, status, note } = await c.req.json<{ ids: number[]; status: string; note?: string }>();
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) return c.json({ error: "Select between 1 and 200 orders" }, 400);
  const results: { orderId: number; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      await setCallingStatus(db, c.get("user"), id, { status, note });
      results.push({ orderId: id, ok: true });
    } catch (err) {
      results.push({ orderId: id, ok: false, error: (err as Error).message });
    }
  }
  c.executionCtx.waitUntil(processJobs(c.env, db, { limit: 25 }));
  return c.json({ results, updated: results.filter((r) => r.ok).length });
});

// ---------------------------------------------------------------------------
// Cancel / delete in Shopify (fake orders etc.)

orderRoutes.post("/:id{[0-9]+}/cancel", requirePerm("orders.cancel"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const order = await loadOrder(db, id);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.cancelledAt) return c.json({ error: "Order is already cancelled" }, 409);
  const body = await c.req.json<{ reason: string; restock?: boolean; notifyCustomer?: boolean; staffNote?: string }>();
  if (!CANCEL_REASONS.includes(body.reason as (typeof CANCEL_REASONS)[number])) return c.json({ error: "Invalid cancellation reason" }, 400);
  if (order.activeConsignmentId && !["cancelled", "returned", "unbooked"].includes(order.courierStage)) {
    return c.json({ error: "This order has an active Steadfast consignment. Stop the parcel with Steadfast first (the API cannot cancel consignments), then cancel the order." }, 409);
  }
  const job = await cancelOrder(c.env, db, order.shopifyId, {
    reason: body.reason as (typeof CANCEL_REASONS)[number],
    restock: body.restock ?? true,
    notifyCustomer: body.notifyCustomer ?? false,
    staffNote: body.staffNote,
  });
  await db.update(orders).set({ cancelRequestedAt: nowIso(), updatedAt: nowIso() }).where(eq(orders.id, id));
  await db.update(orders).set({ autoBookAt: null, autoBookNote: "Cancellation requested" }).where(eq(orders.id, id));
  await logActivity(db, c.get("user"), "order.cancel_requested", { entityType: "order", entityId: id, orderId: id, details: { reason: body.reason, restock: body.restock ?? true, jobId: job?.id } });
  // Shopify cancels asynchronously; the orders/cancelled webhook (or a refresh) records completion.
  c.executionCtx.waitUntil(
    (async () => {
      await new Promise((r) => setTimeout(r, 3000));
      const fresh = await fetchOrder(c.env, db, order.shopifyId).catch(() => null);
      if (fresh) await upsertOrder(db, fresh, await getSettings(db));
    })(),
  );
  return c.json({ ok: true, job });
});

/** Deletes in Shopify when allowed; otherwise archives (closes) it in Shopify and archives it here. */
orderRoutes.post("/:id{[0-9]+}/delete", requirePerm("orders.cancel"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const order = await loadOrder(db, id);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.activeConsignmentId && !["cancelled", "returned", "delivered", "unbooked"].includes(order.courierStage)) {
    return c.json({ error: "Orders with an active consignment cannot be deleted" }, 409);
  }
  const result = await deleteOrder(c.env, db, order.shopifyId);
  let archivedInShopify = false;
  if (!result.deleted) {
    try {
      await closeOrder(c.env, db, order.shopifyId);
      archivedInShopify = true;
    } catch (err) {
      // Closing can also be refused (e.g. unpaid/unfulfilled rules); we still archive locally.
      result.error = `${result.error ?? ""} ${(err as Error).message}`.trim();
    }
  }
  if (result.deleted) await markDeletedInShopify(db, order.shopifyId, c.get("user"));
  await db.update(orders).set({ archived: true, updatedAt: nowIso() }).where(eq(orders.id, id));
  await logActivity(db, c.get("user"), result.deleted ? "order.deleted_from_dashboard" : "order.archived", {
    entityType: "order",
    entityId: id,
    orderId: id,
    details: { deleted: result.deleted, archivedInShopify, shopifyMessage: result.error },
  });
  return c.json({ deleted: result.deleted, archivedInShopify, archivedHere: true, message: result.error ?? null });
});

// ---------------------------------------------------------------------------
// Auto-booking timer controls

orderRoutes.post("/:id{[0-9]+}/auto-book", requirePerm("courier.book"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const { action } = await c.req.json<{ action: "cancel" | "now" | "restart" }>();
  const { cancelAutoBook, scheduleAutoBook } = await import("../services/autobook");
  const user = c.get("user");
  if (action === "cancel") {
    await cancelAutoBook(db, id, `Timer cancelled by ${user.name}`);
    await logActivity(db, user, "courier.auto_book_cancelled", { entityType: "order", entityId: id, orderId: id });
    return c.json({ ok: true });
  }
  if (action === "restart") {
    const at = await scheduleAutoBook(db, id);
    if (!at) return c.json({ error: "Only confirmed, unbooked orders can be scheduled (and auto-booking must be enabled in Settings)" }, 400);
    return c.json({ ok: true, autoBookAt: at });
  }
  if (action === "now") {
    await cancelAutoBook(db, id, null);
    const results = await bookOrders(c.env, db, user, [id], {}, (p) => c.executionCtx.waitUntil(p));
    return c.json({ results });
  }
  return c.json({ error: "Unknown action" }, 400);
});
