import { Hono } from "hono";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb } from "../db";
import { consignments, orders, returns, trackingEvents } from "../db/schema";
import { requirePerm } from "../lib/auth";
import { HttpError, nowIso } from "../lib/util";
import { logActivity } from "../services/activity";
import { applyCourierUpdate, detachCombined, pollActiveConsignments } from "../services/courier";
import { onNotPrintable } from "../services/dispatch";
import * as steadfast from "../services/steadfast";
import * as carrybee from "../services/carrybee";
import { getSettings } from "../services/settings";
import { CARRYBEE_STATUSES } from "../../shared/couriers";
import { STEADFAST_STATUSES } from "../../shared/constants";

export const consignmentRoutes = new Hono<AppEnv>();

consignmentRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));
  const conds: SQL[] = [];
  if (q.stage) conds.push(inArray(consignments.stage, q.stage.split(",")));
  if (q.status) conds.push(inArray(consignments.status, q.status.split(",")));
  if (q.active === "1") conds.push(eq(consignments.isFinal, false));
  if (q.superseded !== "1") conds.push(eq(consignments.superseded, false));
  if (q.settled === "1") conds.push(sql`${consignments.paymentId} is not null`);
  if (q.settled === "0") conds.push(isNull(consignments.paymentId));
  if (q.from) conds.push(gte(consignments.createdAt, q.from));
  if (q.to) conds.push(lte(consignments.createdAt, q.to));
  if (q.stale === "1") conds.push(and(eq(consignments.isFinal, false), lte(consignments.lastStatusAt, new Date(Date.now() - 5 * 86_400_000).toISOString()))!);
  if (q.search?.trim()) {
    const like = `%${q.search.trim().replace(/[%_]/g, "")}%`;
    conds.push(
      or(
        sql`${consignments.trackingCode} like ${like}`,
        sql`${consignments.consignmentId} like ${like}`,
        sql`${consignments.invoice} like ${like}`,
        sql`${consignments.recipientPhone} like ${like}`,
        sql`${consignments.recipientName} like ${like}`,
      )!,
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const [rows, total] = await Promise.all([
    db
      .select({ c: consignments, orderName: orders.name, fulfillmentState: orders.fulfillmentState, orderCancelledAt: orders.cancelledAt })
      .from(consignments)
      .innerJoin(orders, eq(orders.id, consignments.orderId))
      .where(where)
      .orderBy(desc(consignments.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all(),
    db.select({ n: sql<number>`count(*)` }).from(consignments).where(where).get(),
  ]);
  return c.json({
    rows: rows.map((r) => ({
      ...r.c,
      orderName: r.orderName,
      fulfillmentState: r.fulfillmentState,
      orderCancelledAt: r.orderCancelledAt,
      trackingUrl: r.c.trackingCode && r.c.courier === "steadfast" ? steadfast.trackingUrl(c.env, r.c.trackingCode) : null,
    })),
    total: total?.n ?? 0,
    page,
    pageSize,
  });
});

consignmentRoutes.get("/:id{[0-9]+}/events", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(trackingEvents)
    .where(eq(trackingEvents.consignmentRowId, Number(c.req.param("id"))))
    .orderBy(desc(trackingEvents.occurredAt), desc(trackingEvents.id))
    .all();
  return c.json({ events: rows });
});

/** Fetch the latest status from Steadfast right now. */
consignmentRoutes.post("/refresh", requirePerm("courier.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const { ids } = await c.req.json<{ ids: number[] }>();
  if (!Array.isArray(ids) || !ids.length || ids.length > 50) return c.json({ error: "Select between 1 and 50 consignments" }, 400);
  const result = await pollActiveConsignments(c.env, db, { ids });
  return c.json(result);
});

/** Manual status override (e.g. Steadfast support confirmed something not reflected via API). */
consignmentRoutes.post("/:id{[0-9]+}/status", requirePerm("courier.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(consignments).where(eq(consignments.id, Number(c.req.param("id")))).get();
  if (!row) return c.json({ error: "Consignment not found" }, 404);
  const { status, message, collectedAmount } = await c.req.json<{ status: string; message?: string; collectedAmount?: number }>();
  if (!status) return c.json({ error: "Status is required" }, 400);
  const known = row.courier === "carrybee" ? CARRYBEE_STATUSES : STEADFAST_STATUSES;
  if (!(status in known)) return c.json({ error: `Unknown ${row.courier} status "${status}"` }, 400);
  const user = c.get("user");
  await applyCourierUpdate(db, row, { status, message: message ? `${message} (manual: ${user.name})` : `Manually set by ${user.name}`, codAmount: collectedAmount ?? null, source: "manual" }, user);
  return c.json({ ok: true });
});

consignmentRoutes.post("/:id{[0-9]+}/note", requirePerm("courier.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(consignments).where(eq(consignments.id, Number(c.req.param("id")))).get();
  if (!row) return c.json({ error: "Consignment not found" }, 404);
  const { message } = await c.req.json<{ message: string }>();
  if (!message?.trim()) return c.json({ error: "Message is required" }, 400);
  const now = nowIso();
  await db.insert(trackingEvents).values({
    consignmentRowId: row.id,
    orderId: row.orderId,
    kind: "system",
    message: `${message.trim()} — ${c.get("user").name}`,
    source: "manual",
    occurredAt: now,
    createdAt: now,
  });
  return c.json({ ok: true });
});

/**
 * Cancels a Carrybee parcel through Carrybee's API (Steadfast has no cancel API). Before pickup the
 * parcel is cancelled here at once; after pickup the request is recorded and the outcome arrives by webhook.
 */
consignmentRoutes.post("/:id{[0-9]+}/cancel", requirePerm("courier.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(consignments).where(eq(consignments.id, Number(c.req.param("id")))).get();
  if (!row?.consignmentId) return c.json({ error: "Consignment not found" }, 404);
  if (row.courier !== "carrybee") return c.json({ error: "Steadfast parcels are cancelled in the Steadfast portal" }, 400);
  if (row.isFinal) return c.json({ error: "This parcel is already finished" }, 409);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const reason = body.reason?.trim();
  if (!reason) return c.json({ error: "A reason is required" }, 400);
  try {
    await carrybee.cancelOrder(c.env, (await getSettings(db)).carrybeeEnvironment, row.consignmentId, reason);
  } catch (err) {
    return c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500);
  }
  const user = c.get("user");
  if (!row.pickedUpAt) await applyCourierUpdate(db, row, { status: "cancelled", message: `Cancelled by ${user.name}: ${reason}`, source: "manual" }, user);
  else await db.insert(trackingEvents).values({ consignmentRowId: row.id, orderId: row.orderId, kind: "tracking", message: `Cancellation requested by ${user.name}: ${reason}`, source: "manual", occurredAt: nowIso(), createdAt: nowIso() });
  await logActivity(db, user, "courier.cancelled", { entityType: "consignment", entityId: row.consignmentId, orderId: row.orderId, details: { courier: "carrybee", reason, pickedUp: Boolean(row.pickedUpAt) } });
  return c.json({ ok: true, cancelled: !row.pickedUpAt });
});

/** Steadfast return request for a delivered parcel (customer return after delivery). */
consignmentRoutes.post("/:id{[0-9]+}/return-request", requirePerm("courier.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(consignments).where(eq(consignments.id, Number(c.req.param("id")))).get();
  if (!row?.consignmentId) return c.json({ error: "Consignment not found" }, 404);
  if (row.courier !== "steadfast") return c.json({ error: "Return requests are a Steadfast feature; for Carrybee parcels arrange the return in the Carrybee panel" }, 400);
  const { reason } = await c.req.json<{ reason?: string }>();
  const existing = await db
    .select()
    .from(returns)
    .where(and(eq(returns.consignmentRowId, row.id), sql`${returns.steadfastReturnId} is not null`))
    .get();
  if (existing) return c.json({ error: "A Steadfast return request already exists for this consignment" }, 409);
  let rr: steadfast.ReturnRequest;
  try {
    rr = await steadfast.createReturnRequest(c.env, row.consignmentId, reason);
  } catch (err) {
    return c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500);
  }
  const now = nowIso();
  await db.insert(returns).values({
    orderId: row.orderId,
    consignmentRowId: row.id,
    type: "customer_return",
    reason: reason ?? null,
    status: "expected",
    steadfastReturnId: String(rr.id),
    steadfastReturnStatus: rr.status,
    createdBy: c.get("user").id,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(trackingEvents).values({
    consignmentRowId: row.id,
    orderId: row.orderId,
    kind: "system",
    message: `Return request #${rr.id} created${reason ? `: ${reason}` : ""}`,
    source: "api",
    occurredAt: now,
    createdAt: now,
  });
  await logActivity(db, c.get("user"), "courier.return_requested", { entityType: "consignment", entityId: row.consignmentId, orderId: row.orderId, details: { returnId: rr.id, reason } });
  return c.json({ ok: true, returnRequest: rr });
});

/**
 * Discards an unconfirmed booking reservation (create_order outcome unknown) after
 * confirming Steadfast has no consignment for that invoice.
 */
consignmentRoutes.post("/:id{[0-9]+}/discard", requirePerm("courier.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(consignments).where(eq(consignments.id, Number(c.req.param("id")))).get();
  if (!row) return c.json({ error: "Consignment not found" }, 404);
  if (row.consignmentId || row.status !== "unconfirmed") return c.json({ error: "Only unconfirmed bookings can be discarded" }, 400);
  // Only discard when the courier confirms it never received this booking.
  if (row.courier === "carrybee") {
    const found = await carrybee.getOrderDetails(c.env, (await getSettings(db)).carrybeeEnvironment, row.invoice);
    if (found) return c.json({ error: `Carrybee has this order (consignment ${found.consignment_id ?? "?"}). Check the Carrybee panel instead.` }, 409);
  } else {
    const status = await steadfast.getStatusByInvoice(c.env, row.invoice);
    if (status) return c.json({ error: `Steadfast has this invoice (status: ${status}). Check the Steadfast panel instead.` }, 409);
  }
  await db.update(consignments).set({ superseded: true, stage: "cancelled", status: "discarded", isFinal: true }).where(eq(consignments.id, row.id));
  await db.update(orders).set({ courierStage: "unbooked", activeConsignmentId: null }).where(and(eq(orders.id, row.orderId), eq(orders.activeConsignmentId, row.id)));
  await detachCombined(db, row.id);
  await onNotPrintable(db, row.orderId, "Unconfirmed booking discarded", c.get("user"));
  await logActivity(db, c.get("user"), "courier.reservation_discarded", { entityType: "consignment", entityId: row.invoice, orderId: row.orderId });
  return c.json({ ok: true });
});

/** Allows booking the order again (redelivery) by superseding a returned/cancelled consignment. */
consignmentRoutes.post("/:id{[0-9]+}/release", requirePerm("courier.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(consignments).where(eq(consignments.id, Number(c.req.param("id")))).get();
  if (!row) return c.json({ error: "Consignment not found" }, 404);
  if (!["returned", "cancelled"].includes(row.stage)) return c.json({ error: "Only returned or cancelled consignments can be released for rebooking" }, 400);
  await db.update(consignments).set({ superseded: true, updatedAt: nowIso() }).where(eq(consignments.id, row.id));
  await db.update(orders).set({ courierStage: "unbooked", activeConsignmentId: null, updatedAt: nowIso() }).where(eq(orders.id, row.orderId));
  // Orders that travelled in this parcel become bookable on their own again.
  await detachCombined(db, row.id);
  await onNotPrintable(db, row.orderId, "Released for rebooking", c.get("user"));
  await db.update(orders).set({ dispatchStatus: "pending", sortedAt: null, sortedBy: null, sortBatchId: null, pickupId: null, handedOverAt: null, shipBy: null, dispatchedAt: null, dispatchedBy: null, courierReceivedAt: null }).where(eq(orders.id, row.orderId));
  await logActivity(db, c.get("user"), "courier.released_for_rebooking", { entityType: "consignment", entityId: row.consignmentId ?? row.invoice, orderId: row.orderId });
  return c.json({ ok: true });
});
