import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb, type DB } from "../db";
import { activityLog, consignments, customers, customStatuses, orderNotes, orders, returns, trackingEvents, users, type BookingDetails } from "../db/schema";
import { requirePerm } from "../lib/auth";
import { csvEscape, nowIso, normalizeBdPhone } from "../lib/util";
import { getSettings } from "../services/settings";
import { logActivity } from "../services/activity";
import { bookOrders, defaultBooking, effectiveBooking, queueFulfillment, validateBooking } from "../services/courier";
import { customerHistory, refreshRiskFlags, upsertOrder } from "../services/orders";
import { fetchOrder, shopifyAdminOrderUrl } from "../services/shopify";
import { processJobs } from "../services/jobs";
import { trackingUrl } from "../services/steadfast";
import { NOTE_KINDS } from "../../shared/constants";

export const orderRoutes = new Hono<AppEnv>();

const TABS = ["all", "unbooked", "booked", "in_transit", "delivered", "returned", "cancelled", "attention"] as const;

function tabCondition(tab: string): SQL | undefined {
  switch (tab) {
    case "unbooked":
      return and(eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt));
    case "booked":
      return eq(orders.courierStage, "booked");
    case "in_transit":
      return inArray(orders.courierStage, ["in_transit", "on_hold"]);
    case "delivered":
      return inArray(orders.courierStage, ["delivered", "partial_delivered"]);
    case "returned":
      return eq(orders.courierStage, "returned");
    case "cancelled":
      return or(isNotNull(orders.cancelledAt), eq(orders.courierStage, "cancelled"));
    case "attention":
      return or(
        and(sql`json_array_length(coalesce(${orders.riskFlags}, '[]')) > 0`, eq(orders.riskDismissed, false), eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt)),
        inArray(orders.courierStage, ["issue", "on_hold"]),
        eq(orders.fulfillmentState, "failed"),
        and(isNotNull(orders.cancelledAt), inArray(orders.courierStage, ["booked", "in_transit", "on_hold"])),
      );
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
  if (q.statusId) conds.push(q.statusId === "none" ? isNull(orders.statusId) : eq(orders.statusId, Number(q.statusId)));
  if (q.stage) conds.push(inArray(orders.courierStage, q.stage.split(",")));
  if (q.fulfillment) conds.push(inArray(orders.fulfillmentState, q.fulfillment.split(",")));
  if (q.financial) conds.push(inArray(orders.financialStatus, q.financial.split(",")));
  if (q.flagged === "1") conds.push(and(sql`json_array_length(coalesce(${orders.riskFlags}, '[]')) > 0`, eq(orders.riskDismissed, false))!);
  if (q.tag) conds.push(sql`exists (select 1 from json_each(coalesce(${orders.internalTags}, '[]')) where value = ${q.tag})`);
  if (q.from) conds.push(gte(orders.shopCreatedAt, q.from));
  if (q.to) conds.push(lte(orders.shopCreatedAt, q.to));
  if (q.customerId) conds.push(eq(orders.customerId, Number(q.customerId)));
  if (q.ids) conds.push(inArray(orders.id, q.ids.split(",").map(Number).filter(Boolean)));
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
  return c.json({ rows, total: total?.n ?? 0, page, pageSize, tabCounts: Object.fromEntries(tabCounts) });
});

orderRoutes.get("/export.csv", requirePerm("export"), async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const where = and(...filterConditions(q), tabCondition(q.tab ?? "all"));
  const statuses = new Map((await db.select().from(customStatuses).all()).map((s) => [s.id, s.name]));
  const rows = await db
    .select({ o: orders, c: consignments })
    .from(orders)
    .leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId))
    .where(where)
    .orderBy(desc(orders.shopCreatedAt))
    .limit(10_000)
    .all();
  const header = [
    "Order", "Created", "Customer", "Phone", "Address", "City", "Items", "Total", "COD due", "Payment", "Shopify fulfillment",
    "Status", "Tags", "Courier stage", "Consignment ID", "Tracking code", "Steadfast status", "COD booked", "Collected", "Delivery charge",
    "Fulfillment", "Settled payment", "Risk flags",
  ];
  const lines = [header.join(",")];
  for (const { o, c: cn } of rows) {
    lines.push(
      [
        o.name, o.shopCreatedAt, o.customerName, o.phone ?? o.rawPhone, [o.address1, o.address2].filter(Boolean).join(", "), o.city,
        o.lineItems.map((li) => `${li.quantity}x ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ""}`).join("; "),
        o.total, o.outstanding, o.financialStatus, o.shopifyFulfillmentStatus, o.statusId ? statuses.get(o.statusId) : "",
        (o.internalTags ?? []).join("; "), o.courierStage, cn?.consignmentId, cn?.trackingCode, cn?.status, cn?.codAmount,
        cn?.collectedAmount, cn?.deliveryCharge, o.fulfillmentState, cn?.paymentId, o.riskDismissed ? "" : (o.riskFlags ?? []).join("; "),
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
  const rows = await db
    .select({ o: orders, c: consignments })
    .from(orders)
    .leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId))
    .where(inArray(orders.id, ids))
    .all();
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

async function loadOrder(db: DB, id: number) {
  const order = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return null;
  return order;
}

orderRoutes.get("/:id{[0-9]+}", async (c) => {
  const db = getDb(c.env.DB);
  const order = await loadOrder(db, Number(c.req.param("id")));
  if (!order) return c.json({ error: "Order not found" }, 404);
  const appSettings = await getSettings(db);
  const [customer, history, cons, events, notes, activity, rets, duplicates] = await Promise.all([
    order.customerId ? db.select().from(customers).where(eq(customers.id, order.customerId)).get() : null,
    order.customerId ? customerHistory(db, order.customerId) : null,
    db.select().from(consignments).where(eq(consignments.orderId, order.id)).orderBy(desc(consignments.createdAt)).all(),
    db.select().from(trackingEvents).where(eq(trackingEvents.orderId, order.id)).orderBy(desc(trackingEvents.occurredAt), desc(trackingEvents.id)).all(),
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
    consignments: cons.map((x) => ({ ...x, trackingUrl: x.trackingCode ? trackingUrl(c.env, x.trackingCode) : null })),
    events,
    notes: notes.map((n) => ({ ...n.note, userName: n.userName })),
    activity,
    returns: rets,
    shopifyUrl: shopifyAdminOrderUrl(c.env, order.shopifyId),
  });
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
  const rows = await db.select({ id: orders.id, internalTags: orders.internalTags }).from(orders).where(inArray(orders.id, ids)).all();
  const now = nowIso();
  switch (action) {
    case "set_status": {
      const statusId = value === null || value === "" ? null : Number(value);
      await db.update(orders).set({ statusId, updatedAt: now }).where(inArray(orders.id, ids));
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
      await db.update(orders).set({ riskDismissed: true, updatedAt: now }).where(inArray(orders.id, ids));
      break;
    case "archive":
    case "unarchive":
      await db.update(orders).set({ archived: action === "archive", updatedAt: now }).where(inArray(orders.id, ids));
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
  const { ids, override, allowRisky } = await c.req.json<{ ids: number[]; override?: Partial<BookingDetails>; allowRisky?: boolean }>();
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: "No orders selected" }, 400);
  if (ids.length > 100) return c.json({ error: "Book at most 100 orders per request" }, 400);
  if (override && ids.length > 1) return c.json({ error: "Booking overrides apply to a single order" }, 400);
  const results = await bookOrders(c.env, db, c.get("user"), ids, { override, allowRisky }, (p) => c.executionCtx.waitUntil(p));
  return c.json({ results, booked: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
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
