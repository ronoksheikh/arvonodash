import { Hono } from "hono";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb } from "../db";
import { activityLog, consignments, customers, orderNotes, orders, payments, returns, users } from "../db/schema";
import { requirePerm } from "../lib/auth";
import { nowIso, startOfDayIso } from "../lib/util";
import { logActivity } from "../services/activity";
import { ATTENTION_SQL, customerHistory, refreshRiskFlags } from "../services/orders";
import { getSettings } from "../services/settings";
import { stuckParcels } from "../services/stuck";
import * as steadfast from "../services/steadfast";
import { RETURN_FOLLOW_UPS, RETURN_STATUSES } from "../../shared/constants";

// ---------------------------------------------------------------------------
// Dashboard overview — all numbers come from D1.

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const tz = c.env.APP_TIMEZONE_OFFSET || "+06:00";
  const days = Math.min(90, Math.max(7, Number(c.req.query("days")) || 30));
  const today = startOfDayIso(tz);
  const since = startOfDayIso(tz, days - 1);
  // Live work queue: not archived, not cancelled, and not already fulfilled in Shopify outside ARVONO.
  const live = and(eq(orders.archived, false), isNull(orders.cancelledAt), sql`coalesce(${orders.shopifyFulfillmentStatus}, '') not in ('fulfilled', 'partially_fulfilled', 'partial')`);

  const count = async (where: SQL | undefined) => (await db.select({ n: sql<number>`count(*)` }).from(orders).where(where).get())?.n ?? 0;

  const [toCall, readyToBook, todayOrders, todayRevenue, unbooked, booked, inTransit, delivered, returned, attention] = await Promise.all([
    count(and(live, eq(orders.courierStage, "unbooked"), inArray(orders.callingStatus, ["not_called", "no_answer", "call_again"]))),
    count(and(live, eq(orders.courierStage, "unbooked"), eq(orders.callingStatus, "confirmed"))),
    count(and(eq(orders.archived, false), gte(orders.shopCreatedAt, today))),
    db.select({ v: sql<number>`coalesce(sum(${orders.total}), 0)` }).from(orders).where(and(eq(orders.archived, false), isNull(orders.cancelledAt), gte(orders.shopCreatedAt, today))).get(),
    count(and(live, eq(orders.courierStage, "unbooked"))),
    count(and(eq(orders.archived, false), eq(orders.courierStage, "booked"))),
    count(and(eq(orders.archived, false), inArray(orders.courierStage, ["in_transit", "on_hold", "awaiting_confirmation"]))),
    count(and(eq(orders.archived, false), inArray(orders.courierStage, ["delivered", "partial_delivered"]), gte(orders.shopCreatedAt, since))),
    count(and(eq(orders.archived, false), eq(orders.courierStage, "returned"), gte(orders.shopCreatedAt, since))),
    count(
      and(
        eq(orders.archived, false),
        ATTENTION_SQL,
      ),
    ),
  ]);

  // COD (period, by consignment creation date)
  const cod = await db
    .select({
      booked: sql<number>`coalesce(sum(${consignments.codAmount}), 0)`,
      collected: sql<number>`coalesce(sum(case when ${consignments.stage} in ('delivered','partial_delivered') then coalesce(${consignments.collectedAmount}, ${consignments.codAmount}) end), 0)`,
      inTransit: sql<number>`coalesce(sum(case when ${consignments.isFinal} = 0 then ${consignments.codAmount} end), 0)`,
      settled: sql<number>`coalesce(sum(case when ${consignments.paymentId} is not null then coalesce(${consignments.collectedAmount}, 0) end), 0)`,
      charges: sql<number>`coalesce(sum(${consignments.deliveryCharge}), 0)`,
    })
    .from(consignments)
    .where(and(eq(consignments.superseded, false), gte(consignments.createdAt, since)))
    .get();
  // Success rate counts every delivery attempt, including returned parcels that were later rebooked.
  const outcomes = await db
    .select({
      deliveredCount: sql<number>`coalesce(sum(case when ${consignments.stage} in ('delivered','partial_delivered') then 1 else 0 end), 0)`,
      returnedCount: sql<number>`coalesce(sum(case when ${consignments.stage} = 'returned' then 1 else 0 end), 0)`,
    })
    .from(consignments)
    .where(gte(consignments.createdAt, since))
    .get();
  const finished = (outcomes?.deliveredCount ?? 0) + (outcomes?.returnedCount ?? 0);

  // Daily trend (business-day buckets)
  const offsetMinutes = (() => {
    const sign = tz.startsWith("-") ? -1 : 1;
    const [h, m] = tz.replace(/^[+-]/, "").split(":").map(Number);
    return sign * ((h || 0) * 60 + (m || 0));
  })();
  const shift = `${offsetMinutes >= 0 ? "+" : ""}${offsetMinutes} minutes`;
  const trend = await db
    .select({
      day: sql<string>`date(${orders.shopCreatedAt}, ${shift})`,
      orders: sql<number>`count(*)`,
      revenue: sql<number>`coalesce(sum(case when ${orders.cancelledAt} is null then ${orders.total} end), 0)`,
      cancelled: sql<number>`sum(case when ${orders.cancelledAt} is not null then 1 else 0 end)`,
    })
    .from(orders)
    .where(and(eq(orders.archived, false), gte(orders.shopCreatedAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all();
  const deliveryTrend = await db
    .select({
      day: sql<string>`date(coalesce(${consignments.deliveredAt}, ${consignments.returnedAt}), ${shift})`,
      delivered: sql<number>`sum(case when ${consignments.stage} in ('delivered','partial_delivered') then 1 else 0 end)`,
      returned: sql<number>`sum(case when ${consignments.stage} = 'returned' then 1 else 0 end)`,
    })
    .from(consignments)
    .where(sql`coalesce(${consignments.deliveredAt}, ${consignments.returnedAt}) >= ${since}`)
    .groupBy(sql`1`)
    .all();

  const needsAttention = await db
    .select({
      id: orders.id,
      name: orders.name,
      customerName: orders.customerName,
      courierStage: orders.courierStage,
      fulfillmentState: orders.fulfillmentState,
      riskFlags: orders.riskFlags,
      cancelledAt: orders.cancelledAt,
      shopCreatedAt: orders.shopCreatedAt,
      total: orders.total,
    })
    .from(orders)
    .where(
      and(
        eq(orders.archived, false),
        ATTENTION_SQL,
      ),
    )
    .orderBy(desc(orders.shopCreatedAt))
    .limit(8)
    .all();

  const recentActivity = await db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(12).all();

  const oldestUnbooked = await db
    .select({ at: sql<string>`min(${orders.shopCreatedAt})` })
    .from(orders)
    .where(and(live, eq(orders.courierStage, "unbooked")))
    .get();

  return c.json({
    days,
    today: { orders: todayOrders, revenue: todayRevenue?.v ?? 0 },
    pipeline: { toCall, readyToBook, unbooked, booked, inTransit, delivered, returned, attention, stuck: (await stuckParcels(db, await getSettings(db))).parcels.length },
    steadfastPause: await steadfast.steadfastPause(c.env),
    oldestUnbookedAt: oldestUnbooked?.at ?? null,
    cod: {
      booked: cod?.booked ?? 0,
      collected: cod?.collected ?? 0,
      inTransit: cod?.inTransit ?? 0,
      settled: cod?.settled ?? 0,
      deliveryCharges: cod?.charges ?? 0,
    },
    successRate: finished ? Math.round(((outcomes?.deliveredCount ?? 0) / finished) * 1000) / 10 : null,
    deliveredCount: outcomes?.deliveredCount ?? 0,
    returnedCount: outcomes?.returnedCount ?? 0,
    // One entry per business day, zero-filled so quiet days still show on the chart.
    trend: Array.from({ length: days }, (_, i) => {
      const dayKey = new Date(Date.parse(since) + offsetMinutes * 60_000 + i * 86_400_000).toISOString().slice(0, 10);
      const t = trend.find((x) => x.day === dayKey) ?? { orders: 0, revenue: 0, cancelled: 0 };
      const dl = deliveryTrend.find((x) => x.day === dayKey) ?? { delivered: 0, returned: 0 };
      return { day: dayKey, orders: t.orders, revenue: t.revenue, cancelled: t.cancelled, delivered: dl.delivered ?? 0, returned: dl.returned ?? 0 };
    }),
    needsAttention,
    recentActivity,
  });
});

// ---------------------------------------------------------------------------
// Customers

export const customerRoutes = new Hono<AppEnv>();

customerRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));
  const conds: SQL[] = [];
  if (q.search?.trim()) {
    const like = `%${q.search.trim().replace(/[%_]/g, "")}%`;
    conds.push(sql`(${customers.name} like ${like} or ${customers.phone} like ${like} or ${customers.email} like ${like})`);
  }
  if (q.flag) conds.push(q.flag === "none" ? isNull(customers.flag) : eq(customers.flag, q.flag));
  const where = conds.length ? and(...conds) : undefined;
  const stats = db
    .select({
      customerId: orders.customerId,
      orders: sql<number>`count(distinct ${orders.id})`.as("orders"),
      delivered: sql<number>`count(distinct case when ${orders.courierStage} in ('delivered','partial_delivered') then ${orders.id} end)`.as("delivered"),
      returned: sql<number>`count(distinct case when ${orders.courierStage} = 'returned' then ${orders.id} end)`.as("returned"),
      spent: sql<number>`coalesce(sum(case when ${orders.courierStage} = 'delivered' then ${orders.total} end), 0)`.as("spent"),
      lastOrderAt: sql<string>`max(${orders.shopCreatedAt})`.as("last_order_at"),
    })
    .from(orders)
    .where(isNotNull(orders.customerId))
    .groupBy(orders.customerId)
    .as("stats");
  const sortMap = { orders: stats.orders, returned: stats.returned, last: stats.lastOrderAt, spent: stats.spent } as const;
  const sortCol = sortMap[(q.sort as keyof typeof sortMap) ?? "last"] ?? stats.lastOrderAt;
  const [rows, total] = await Promise.all([
    db
      .select({ customer: customers, orders: stats.orders, delivered: stats.delivered, returned: stats.returned, spent: stats.spent, lastOrderAt: stats.lastOrderAt })
      .from(customers)
      .leftJoin(stats, eq(stats.customerId, customers.id))
      .where(where)
      .orderBy(desc(sortCol))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all(),
    db.select({ n: sql<number>`count(*)` }).from(customers).where(where).get(),
  ]);
  return c.json({
    rows: rows.map((r) => {
      const finished = (r.delivered ?? 0) + (r.returned ?? 0);
      return { ...r.customer, orders: r.orders ?? 0, delivered: r.delivered ?? 0, returned: r.returned ?? 0, spent: r.spent ?? 0, lastOrderAt: r.lastOrderAt, successRate: finished ? Math.round(((r.delivered ?? 0) / finished) * 100) : null };
    }),
    total: total?.n ?? 0,
    page,
    pageSize,
  });
});

customerRoutes.get("/:id{[0-9]+}", async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const customer = await db.select().from(customers).where(eq(customers.id, id)).get();
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  const [history, orderRows, notes, rets] = await Promise.all([
    customerHistory(db, id),
    db
      .select({
        id: orders.id,
        name: orders.name,
        shopCreatedAt: orders.shopCreatedAt,
        total: orders.total,
        courierStage: orders.courierStage,
        cancelledAt: orders.cancelledAt,
        fulfillmentState: orders.fulfillmentState,
        city: orders.city,
      })
      .from(orders)
      .where(eq(orders.customerId, id))
      .orderBy(desc(orders.shopCreatedAt))
      .limit(100)
      .all(),
    db
      .select({ note: orderNotes, userName: users.name, orderName: orders.name })
      .from(orderNotes)
      .leftJoin(users, eq(users.id, orderNotes.userId))
      .leftJoin(orders, eq(orders.id, orderNotes.orderId))
      .where(eq(orderNotes.customerId, id))
      .orderBy(desc(orderNotes.createdAt))
      .limit(100)
      .all(),
    db
      .select({ r: returns, orderName: orders.name })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .where(eq(orders.customerId, id))
      .orderBy(desc(returns.createdAt))
      .all(),
  ]);
  return c.json({
    customer,
    history,
    orders: orderRows,
    notes: notes.map((n) => ({ ...n.note, userName: n.userName, orderName: n.orderName })),
    returns: rets.map((r) => ({ ...r.r, orderName: r.orderName })),
  });
});

customerRoutes.patch("/:id{[0-9]+}", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ note?: string | null; flag?: string | null; tags?: string[] }>();
  const patch: Partial<typeof customers.$inferInsert> = { updatedAt: nowIso() };
  if ("note" in body) patch.note = body.note?.slice(0, 4000) ?? null;
  if ("flag" in body) {
    if (body.flag && !["vip", "risky", "blocked"].includes(body.flag)) return c.json({ error: "Invalid flag" }, 400);
    patch.flag = body.flag || null;
  }
  if (Array.isArray(body.tags)) patch.tags = body.tags.map((t) => t.trim()).filter(Boolean).slice(0, 30);
  await db.update(customers).set(patch).where(eq(customers.id, id));
  if ("flag" in body) {
    // Re-evaluate risk on this customer's open orders.
    const appSettings = await getSettings(db);
    const open = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.customerId, id), eq(orders.courierStage, "unbooked"))).all();
    for (const o of open) await refreshRiskFlags(db, o.id, appSettings);
  }
  await logActivity(db, c.get("user"), "customer.updated", { entityType: "customer", entityId: id, details: body });
  return c.json({ ok: true });
});

customerRoutes.post("/:id{[0-9]+}/notes", requirePerm("orders.edit"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ kind: string; body: string; rating?: number }>();
  if (!body.body?.trim()) return c.json({ error: "Text is required" }, 400);
  await db.insert(orderNotes).values({
    customerId: id,
    kind: ["internal", "call_log", "customer_review", "rider_feedback"].includes(body.kind) ? body.kind : "internal",
    body: body.body.trim().slice(0, 4000),
    rating: body.kind === "customer_review" && body.rating ? Math.min(5, Math.max(1, Math.round(body.rating))) : null,
    userId: c.get("user").id,
    createdAt: nowIso(),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Returns

export const returnRoutes = new Hono<AppEnv>();

returnRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const conds: SQL[] = [];
  if (q.status) conds.push(inArray(returns.status, q.status.split(",")));
  if (q.type) conds.push(eq(returns.type, q.type));
  if (q.open === "1") conds.push(sql`${returns.status} != 'closed'`);
  const rows = await db
    .select({
      r: returns,
      orderName: orders.name,
      customerName: orders.customerName,
      phone: orders.phone,
      customerId: orders.customerId,
      total: orders.total,
      trackingCode: consignments.trackingCode,
      consignmentId: consignments.consignmentId,
      consignmentStatus: consignments.status,
    })
    .from(returns)
    .innerJoin(orders, eq(orders.id, returns.orderId))
    .leftJoin(consignments, eq(consignments.id, returns.consignmentRowId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(returns.createdAt))
    .limit(500)
    .all();
  const counts = await db.select({ status: returns.status, n: sql<number>`count(*)` }).from(returns).groupBy(returns.status).all();
  return c.json({
    rows: rows.map((r) => ({ ...r.r, orderName: r.orderName, customerName: r.customerName, phone: r.phone, customerId: r.customerId, total: r.total, trackingCode: r.trackingCode, consignmentId: r.consignmentId, consignmentStatus: r.consignmentStatus })),
    counts: Object.fromEntries(counts.map((x) => [x.status, x.n])),
  });
});

returnRoutes.post("/", requirePerm("returns.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ orderId: number; type?: string; reason?: string; notes?: string }>();
  const order = await db.select().from(orders).where(eq(orders.id, body.orderId)).get();
  if (!order) return c.json({ error: "Order not found" }, 404);
  const now = nowIso();
  const row = await db
    .insert(returns)
    .values({
      orderId: order.id,
      consignmentRowId: order.activeConsignmentId,
      type: ["courier_return", "partial_return", "customer_return"].includes(body.type ?? "") ? body.type! : "customer_return",
      reason: body.reason ?? null,
      notes: body.notes ?? null,
      status: "expected",
      createdBy: c.get("user").id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  await logActivity(db, c.get("user"), "return.created", { entityType: "return", entityId: row!.id, orderId: order.id });
  return c.json({ return: row });
});

returnRoutes.patch("/:id{[0-9]+}", requirePerm("returns.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(returns).where(eq(returns.id, id)).get();
  if (!existing) return c.json({ error: "Return not found" }, 404);
  const body = await c.req.json<Partial<{ status: string; reason: string; notes: string; condition: string; followUpAction: string; followUpAt: string | null; restockConfirmed: boolean; refundConfirmed: boolean }>>();
  const patch: Partial<typeof returns.$inferInsert> = { updatedAt: nowIso() };
  if (body.status) {
    if (!(body.status in RETURN_STATUSES)) return c.json({ error: "Invalid status" }, 400);
    patch.status = body.status;
    if (body.status === "received" && !existing.receivedAt) patch.receivedAt = nowIso();
  }
  if (body.followUpAction !== undefined) {
    if (body.followUpAction && !(body.followUpAction in RETURN_FOLLOW_UPS)) return c.json({ error: "Invalid follow-up" }, 400);
    patch.followUpAction = body.followUpAction || null;
  }
  if (body.reason !== undefined) patch.reason = body.reason;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.condition !== undefined) patch.condition = body.condition || null;
  if (body.followUpAt !== undefined) patch.followUpAt = body.followUpAt;
  // Restock / refund are recorded as staff confirmations only; nothing is changed in Shopify automatically.
  if (typeof body.restockConfirmed === "boolean") patch.restockConfirmed = body.restockConfirmed;
  if (typeof body.refundConfirmed === "boolean") patch.refundConfirmed = body.refundConfirmed;
  await db.update(returns).set(patch).where(eq(returns.id, id));
  await logActivity(db, c.get("user"), "return.updated", { entityType: "return", entityId: id, orderId: existing.orderId, details: body });
  return c.json({ ok: true });
});

returnRoutes.post("/:id{[0-9]+}/sync", requirePerm("returns.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const row = await db.select().from(returns).where(eq(returns.id, id)).get();
  if (!row?.steadfastReturnId) return c.json({ error: "This return has no Steadfast return request" }, 400);
  const rr = await steadfast.getReturnRequest(c.env, row.steadfastReturnId);
  await db.update(returns).set({ steadfastReturnStatus: rr.status, updatedAt: nowIso() }).where(eq(returns.id, id));
  return c.json({ ok: true, status: rr.status });
});

// ---------------------------------------------------------------------------
// COD & settlements

export const codRoutes = new Hono<AppEnv>();

codRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const tz = c.env.APP_TIMEZONE_OFFSET || "+06:00";
  const days = Math.min(365, Math.max(7, Number(c.req.query("days")) || 30));
  const since = startOfDayIso(tz, days - 1);
  const live = and(eq(consignments.superseded, false), gte(consignments.createdAt, since));
  const summary = await db
    .select({
      bookedCount: sql<number>`count(*)`,
      booked: sql<number>`coalesce(sum(${consignments.codAmount}), 0)`,
      collected: sql<number>`coalesce(sum(case when ${consignments.stage} in ('delivered','partial_delivered') then coalesce(${consignments.collectedAmount}, ${consignments.codAmount}) end), 0)`,
      pendingCollection: sql<number>`coalesce(sum(case when ${consignments.isFinal} = 0 then ${consignments.codAmount} end), 0)`,
      lost: sql<number>`coalesce(sum(case when ${consignments.stage} = 'returned' then ${consignments.codAmount} end), 0)`,
      settled: sql<number>`coalesce(sum(case when ${consignments.paymentId} is not null then coalesce(${consignments.collectedAmount}, 0) end), 0)`,
      awaitingSettlement: sql<number>`coalesce(sum(case when ${consignments.stage} in ('delivered','partial_delivered') and ${consignments.paymentId} is null then coalesce(${consignments.collectedAmount}, ${consignments.codAmount}) end), 0)`,
      charges: sql<number>`coalesce(sum(${consignments.deliveryCharge}), 0)`,
    })
    .from(consignments)
    .where(live)
    .get();
  const unsettled = await db
    .select({ c: consignments, orderName: orders.name })
    .from(consignments)
    .innerJoin(orders, eq(orders.id, consignments.orderId))
    .where(and(eq(consignments.superseded, false), inArray(consignments.stage, ["delivered", "partial_delivered"]), isNull(consignments.paymentId)))
    .orderBy(consignments.deliveredAt)
    .limit(200)
    .all();
  const paymentRows = await db.select().from(payments).orderBy(desc(payments.paidAt), desc(payments.createdAt)).limit(100).all();
  return c.json({
    days,
    summary,
    unsettled: unsettled.map((u) => ({ ...u.c, orderName: u.orderName })),
    payments: paymentRows,
  });
});

codRoutes.get("/balance", requirePerm("cod.view"), async (c) => {
  return c.json({ balance: await steadfast.getBalance(c.env) });
});

codRoutes.get("/payments/:id", requirePerm("cod.view"), async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const payment = await db.select().from(payments).where(eq(payments.id, id)).get();
  if (!payment) return c.json({ error: "Payment not found" }, 404);
  const linked = await db
    .select({ c: consignments, orderName: orders.name })
    .from(consignments)
    .innerJoin(orders, eq(orders.id, consignments.orderId))
    .where(eq(consignments.paymentId, id))
    .all();
  return c.json({ payment, consignments: linked.map((l) => ({ ...l.c, orderName: l.orderName })) });
});
