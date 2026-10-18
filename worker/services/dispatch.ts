import { and, desc, eq, inArray, sql, type AnyColumn } from "drizzle-orm";
import type { DB } from "../db";
import { inList, pick } from "../db";
import { consignments, dispatchEvents, orders, printJobs, sortBatches } from "../db/schema";
import { HttpError, nowIso } from "../lib/util";

/**
 * Label printing & dispatch state machine.
 *
 *   label:    not_ready → unprinted (on booking) → reserved (claim) → printed (confirmed by label service)
 *                                     ↑               │ release / expiry
 *                                     └───────────────┘   printed → unprinted only via explicit reprint request
 *   dispatch: pending → sorted (label scanned at the packing table) → dispatched (Steadfast picked it up:
 *             its status leaves in_review)
 *
 * Every transition is a single conditional UPDATE, so concurrent callers can never both win.
 */

export type Actor = { name: string; id?: number | null };

// ---------------------------------------------------------------------------
// Business-day helpers (Asia/Dhaka by default)

export function offsetMinutes(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.replace(/^[+-]/, "").split(":").map(Number);
  return sign * ((h || 0) * 60 + (m || 0));
}

/** Converts a local business date (YYYY-MM-DD) into a [start, end) UTC ISO range. */
export function dayRange(date: string, offset: string, toDate?: string): { from: string; to: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(date) || (toDate && !re.test(toDate))) throw new HttpError(400, "Dates must be YYYY-MM-DD (Asia/Dhaka business date)");
  const shift = offsetMinutes(offset) * 60_000;
  const from = Date.parse(`${date}T00:00:00Z`) - shift;
  const to = Date.parse(`${toDate ?? date}T00:00:00Z`) - shift + 86_400_000;
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw new HttpError(400, "Invalid date range");
  if (to - from > 62 * 86_400_000) throw new HttpError(400, "Date range can span at most 62 days");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Business date (YYYY-MM-DD) of an instant. */
export function businessDate(iso: string | Date, offset: string): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return new Date(t + offsetMinutes(offset) * 60_000).toISOString().slice(0, 10);
}

/** Orders that can appear in a print run: booked, not yet picked up, not cancelled/archived. */
const printableBase = sql`${orders.courierStage} = 'booked' and ${orders.cancelledAt} is null and ${orders.archived} = 0
  and ${orders.activeConsignmentId} is not null and ${orders.combinedIntoOrderId} is null`;

export async function addEvents(db: DB, rows: { orderId: number; event: string; jobId?: string | null; note?: string | null; consignmentRowId?: number | null }[], actor: Actor) {
  const now = nowIso();
  // D1 limits bound parameters per statement, so insert in small batches.
  for (let i = 0; i < rows.length; i += 10) {
    await db.insert(dispatchEvents).values(
      rows.slice(i, i + 10).map((r) => ({
        orderId: r.orderId,
        consignmentRowId: r.consignmentRowId ?? null,
        event: r.event,
        jobId: r.jobId ?? null,
        actor: actor.name,
        note: r.note ?? null,
        createdAt: now,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// Hooks called by booking / courier updates

/** A fresh booking (or rebooking) makes the order printable again with a new tracking code. */
export async function onBooked(db: DB, orderId: number, consignmentRowId: number, actor: Actor, shipBy: string) {
  await db
    .update(orders)
    .set({ labelStatus: "unprinted", bookedAt: nowIso(), shipBy, carryOverCount: 0, printJobId: null, reservedUntil: null, dispatchStatus: "pending", sortedAt: null, sortedBy: null, sortBatchId: null, pickupId: null, handedOverAt: null, dispatchedAt: null, dispatchedBy: null, courierReceivedAt: null })
    .where(eq(orders.id, orderId));
  await addEvents(db, [{ orderId, event: "label_ready", consignmentRowId, note: `Ships with the pickup on ${shipBy}` }], actor);
}

/** Steadfast picked the parcel up (status left in_review): the order is dispatched. */
export async function onCourierReceived(db: DB, orderId: number, consignmentRowId: number, at: string) {
  const before = await db.select({ sortedAt: orders.sortedAt, handedOverAt: orders.handedOverAt, combined: orders.combinedIntoOrderId }).from(orders).where(eq(orders.id, orderId)).get();
  const row = await db
    .update(orders)
    // Steadfast has it, so it was handed over even if nobody ticked the handover checklist.
    .set({ dispatchStatus: "dispatched", dispatchedAt: at, courierReceivedAt: at, handedOverAt: sql`coalesce(${orders.handedOverAt}, ${at})` })
    .where(and(eq(orders.id, orderId), eq(orders.activeConsignmentId, consignmentRowId), sql`${orders.dispatchStatus} != 'dispatched'`))
    .returning({ id: orders.id })
    .get();
  if (!row) return;
  const events = [{ orderId, event: "dispatched", consignmentRowId }];
  // Worth knowing for packing discipline: it left without the packing-table scan.
  if (before && !before.sortedAt && !before.combined) events.unshift({ orderId, event: "picked_up_unscanned", consignmentRowId });
  await addEvents(db, events, { name: "steadfast" });
}

/** Booking voided (cancelled before pickup, released for rebooking, or order cancelled): not printable. */
export async function onNotPrintable(db: DB, orderId: number, reason: string, actor: Actor) {
  const row = await db
    .update(orders)
    .set({ labelStatus: "not_ready", reservedUntil: null })
    .where(and(eq(orders.id, orderId), sql`${orders.labelStatus} in ('unprinted', 'reserved')`))
    .returning({ id: orders.id })
    .get();
  if (row) await addEvents(db, [{ orderId, event: "released", note: reason }], actor);
}

// ---------------------------------------------------------------------------
// Queries

export type PrintableOrder = ReturnType<typeof toPayload>;

const orderCols = pick(orders, [
  "id", "name", "orderNumber", "shopifyId", "customerName", "phone", "city", "zip", "country", "lineItems", "booking",
  "bookedAt", "labelStatus", "printJobId", "reservedUntil", "printedAt", "printCount", "dispatchStatus", "sortedAt", "dispatchedAt", "courierReceivedAt", "trackingToken",
]);
const consignmentCols = pick(consignments, [
  "invoice", "consignmentId", "trackingCode", "recipientName", "recipientPhone", "recipientAddress", "codAmount", "deliveryType", "note", "lineItems",
]);
type OrderPart = { [K in keyof typeof orderCols]: (typeof orders.$inferSelect)[K] };
type ConsignmentPart = { [K in keyof typeof consignmentCols]: (typeof consignments.$inferSelect)[K] };

function toPayload(o: OrderPart, c: ConsignmentPart | null, offset: string) {
  const wanted = new Map((c?.lineItems ?? []).map((li) => [li.lineItemId, li.quantity]));
  const items = o.lineItems
    .map((li) => ({ title: li.title, variant: li.variantTitle ?? null, sku: li.sku ?? null, quantity: wanted.size ? wanted.get(li.id) ?? 0 : li.quantity }))
    .filter((li) => li.quantity > 0);
  return {
    orderId: o.id,
    orderName: o.name,
    orderNumber: o.orderNumber,
    shopifyOrderId: o.shopifyId,
    invoice: c?.invoice ?? null,
    consignmentId: c?.consignmentId ?? null,
    trackingCode: c?.trackingCode ?? null,
    customer: { name: c?.recipientName ?? o.customerName, phone: c?.recipientPhone ?? o.phone, alternativePhone: o.booking?.alternativePhone ?? null },
    shippingAddress: { address: c?.recipientAddress ?? null, city: o.city, zip: o.zip, country: o.country },
    items,
    totalQuantity: items.reduce((s, i) => s + i.quantity, 0),
    codAmount: c?.codAmount ?? 0,
    deliveryType: c?.deliveryType === 1 ? "point_delivery" : "home_delivery",
    note: c?.note ?? null,
    bookedAt: o.bookedAt,
    bookedDate: o.bookedAt ? businessDate(o.bookedAt, offset) : null,
    labelStatus: o.labelStatus,
    printJobId: o.printJobId,
    reservedUntil: o.reservedUntil,
    printedAt: o.printedAt,
    printCount: o.printCount,
    dispatchStatus: o.dispatchStatus,
    sortedAt: o.sortedAt,
    dispatchedAt: o.dispatchedAt,
    // Customer tracking page; relative here, made absolute by the API route.
    trackingUrl: o.trackingToken ? `/t/${o.trackingToken}` : null,
  };
}

export async function listByLabelStatus(
  db: DB,
  opts: { from?: string; to?: string; status: "unprinted" | "reserved" | "printed" | "all"; limit: number; afterId?: number; offset: string },
) {
  const conds = [];
  if (opts.from && opts.to) conds.push(sql`${orders.bookedAt} >= ${opts.from} and ${orders.bookedAt} < ${opts.to}`);
  if (opts.status === "unprinted") conds.push(printableBase, sql`${orders.labelStatus} = 'unprinted'`);
  else if (opts.status === "reserved") conds.push(sql`${orders.labelStatus} = 'reserved'`);
  else if (opts.status === "printed") conds.push(sql`${orders.labelStatus} = 'printed'`);
  else conds.push(sql`${orders.labelStatus} != 'not_ready'`);
  if (opts.afterId) conds.push(sql`${orders.id} > ${opts.afterId}`);
  const rows = await db
    .select({ o: orderCols, c: consignmentCols })
    .from(orders)
    .leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId))
    .where(and(...conds))
    .orderBy(orders.id)
    .limit(opts.limit + 1)
    .all();
  const page = rows.slice(0, opts.limit).map((r) => toPayload(r.o, r.c, opts.offset));
  return { orders: page, nextCursor: rows.length > opts.limit ? page[page.length - 1].orderId : null };
}

async function loadPayloads(db: DB, ids: number[], offset: string) {
  if (!ids.length) return [];
  const rows = await db.select({ o: orderCols, c: consignmentCols }).from(orders).leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId)).where(inList(orders.id, ids)).orderBy(orders.id).all();
  return rows.map((r) => toPayload(r.o, r.c, offset));
}

// ---------------------------------------------------------------------------
// Reservations

/** Returns expired reservations to the unprinted pool. Safe to run any time. */
export async function expireReservations(db: DB) {
  const now = nowIso();
  const expired = await db
    .update(orders)
    .set({ labelStatus: "unprinted", reservedUntil: null })
    .where(and(eq(orders.labelStatus, "reserved"), sql`${orders.reservedUntil} < ${now}`))
    .returning({ id: orders.id, jobId: orders.printJobId })
    .all();
  if (expired.length) {
    await addEvents(db, expired.map((e) => ({ orderId: e.id, event: "expired", jobId: e.jobId })), { name: "system" });
  }
  await db.update(printJobs).set({ status: "expired" }).where(and(eq(printJobs.status, "reserved"), sql`${printJobs.expiresAt} < ${now}`));
  return { expired: expired.length };
}

/**
 * Atomically reserves up to `limit` unprinted orders for one print job. The single UPDATE ... WHERE
 * label_status = 'unprinted' guarantees two concurrent claims never receive the same order.
 */
export async function claim(
  db: DB,
  actor: Actor,
  opts: { from?: string; to?: string; orderIds?: number[]; limit: number; ttlSeconds: number; offset: string; filters: unknown },
) {
  await expireReservations(db);
  const jobId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + opts.ttlSeconds * 1000).toISOString();
  await db.insert(printJobs).values({ id: jobId, source: actor.name, status: "reserved", filters: opts.filters as object, expiresAt, createdAt: now.toISOString() });

  const conds = [printableBase, sql`${orders.labelStatus} = 'unprinted'`];
  if (opts.from && opts.to) conds.push(sql`${orders.bookedAt} >= ${opts.from} and ${orders.bookedAt} < ${opts.to}`);
  if (opts.orderIds?.length) conds.push(inList(orders.id, opts.orderIds));
  const candidates = db
    .select({ id: orders.id })
    .from(orders)
    .where(and(...conds))
    .orderBy(orders.bookedAt, orders.id)
    .limit(opts.limit);
  const claimed = await db
    .update(orders)
    .set({ labelStatus: "reserved", printJobId: jobId, reservedUntil: expiresAt })
    .where(and(inArray(orders.id, candidates), eq(orders.labelStatus, "unprinted")))
    .returning({ id: orders.id, consignmentRowId: orders.activeConsignmentId })
    .all();

  if (!claimed.length) {
    await db.delete(printJobs).where(eq(printJobs.id, jobId));
    return { jobId: null, expiresAt: null, orders: [] as PrintableOrder[] };
  }
  await db.update(printJobs).set({ orderCount: claimed.length }).where(eq(printJobs.id, jobId));
  await addEvents(db, claimed.map((c) => ({ orderId: c.id, event: "reserved", jobId, consignmentRowId: c.consignmentRowId })), actor);
  return { jobId, expiresAt, orders: await loadPayloads(db, claimed.map((c) => c.id), opts.offset) };
}

type ResultRow = { orderId: number; result: string };

async function refreshJobStatus(db: DB, jobId: string) {
  const counts = await db
    .select({
      reserved: sql<number>`sum(case when ${orders.labelStatus} = 'reserved' then 1 else 0 end)`,
    })
    .from(orders)
    .where(eq(orders.printJobId, jobId))
    .get();
  const printed = (await db.select({ n: sql<number>`count(*)` }).from(dispatchEvents).where(and(eq(dispatchEvents.jobId, jobId), eq(dispatchEvents.event, "printed"))).get())?.n ?? 0;
  const job = await db.select().from(printJobs).where(eq(printJobs.id, jobId)).get();
  if (!job) return;
  const stillReserved = Number(counts?.reserved ?? 0) > 0;
  const status = stillReserved ? (job.status === "expired" ? "expired" : "reserved") : printed >= job.orderCount ? "completed" : printed > 0 ? "partial" : "released";
  await db
    .update(printJobs)
    .set({ printedCount: printed, status, completedAt: stillReserved ? null : nowIso() })
    .where(eq(printJobs.id, jobId));
}

/**
 * Marks labels as printed — only those the label service confirms. Orders must currently be
 * reserved (by this job when jobId is given). A late confirmation for an expired job is still
 * accepted as long as no other job has claimed the order since, which prevents a double print.
 */
export async function markPrinted(db: DB, actor: Actor, opts: { jobId?: string; orderIds?: number[]; failedOrderIds?: number[] }) {
  if (!opts.jobId && !opts.orderIds?.length) throw new HttpError(400, "Provide jobId and/or orderIds");
  if (opts.jobId && !(await db.select({ id: printJobs.id }).from(printJobs).where(eq(printJobs.id, opts.jobId)).get())) {
    throw new HttpError(404, "Print job not found");
  }
  const now = nowIso();
  const conds = [];
  if (opts.jobId) conds.push(eq(orders.printJobId, opts.jobId), sql`${orders.labelStatus} in ('reserved', 'unprinted')`);
  else conds.push(eq(orders.labelStatus, "reserved"));
  if (opts.orderIds?.length) conds.push(inList(orders.id, opts.orderIds));
  if (opts.failedOrderIds?.length) conds.push(sql`not (${inList(orders.id, opts.failedOrderIds)})`);

  const printed = await db
    .update(orders)
    .set({ labelStatus: "printed", printedAt: now, printCount: sql`${orders.printCount} + 1`, reservedUntil: null })
    .where(and(...conds))
    .returning({ id: orders.id, jobId: orders.printJobId, consignmentRowId: orders.activeConsignmentId })
    .all();
  await addEvents(db, printed.map((p) => ({ orderId: p.id, event: "printed", jobId: p.jobId, consignmentRowId: p.consignmentRowId })), actor);

  let released: number[] = [];
  if (opts.failedOrderIds?.length) {
    released = (await release(db, actor, { jobId: opts.jobId, orderIds: opts.failedOrderIds, reason: "Print failed" })).released;
  }

  const results: ResultRow[] = [];
  const printedSet = new Set(printed.map((p) => p.id));
  if (opts.orderIds?.length) {
    const others = opts.orderIds.filter((id) => !printedSet.has(id));
    const states = others.length
      ? await db.select({ id: orders.id, labelStatus: orders.labelStatus, printJobId: orders.printJobId }).from(orders).where(inList(orders.id, others)).all()
      : [];
    for (const id of opts.orderIds) {
      if (printedSet.has(id)) results.push({ orderId: id, result: "printed" });
      else {
        const s = states.find((x) => x.id === id);
        results.push({
          orderId: id,
          result: !s ? "not_found" : s.labelStatus === "printed" ? "already_printed" : opts.jobId && s.printJobId !== opts.jobId ? "not_in_job" : "not_reserved",
        });
      }
    }
  } else {
    for (const p of printed) results.push({ orderId: p.id, result: "printed" });
  }
  const jobIds = new Set([opts.jobId, ...printed.map((p) => p.jobId)].filter(Boolean) as string[]);
  for (const j of jobIds) await refreshJobStatus(db, j);
  return { printed: printed.length, released: released.length, results };
}

export async function release(db: DB, actor: Actor, opts: { jobId?: string; orderIds?: number[]; reason?: string }) {
  if (!opts.jobId && !opts.orderIds?.length) throw new HttpError(400, "Provide jobId and/or orderIds");
  const conds = [eq(orders.labelStatus, "reserved")];
  if (opts.jobId) conds.push(eq(orders.printJobId, opts.jobId));
  if (opts.orderIds?.length) conds.push(inList(orders.id, opts.orderIds));
  const rows = await db
    .update(orders)
    .set({ labelStatus: "unprinted", reservedUntil: null })
    .where(and(...conds))
    .returning({ id: orders.id, jobId: orders.printJobId })
    .all();
  await addEvents(db, rows.map((r) => ({ orderId: r.id, event: "released", jobId: r.jobId, note: opts.reason ?? null })), actor);
  const jobIds = new Set([opts.jobId, ...rows.map((r) => r.jobId)].filter(Boolean) as string[]);
  for (const j of jobIds) await refreshJobStatus(db, j);
  return { released: rows.map((r) => r.id) };
}

/** Manual reprint: a printed label goes back to the unprinted pool, with an audit record. */
export async function requestReprint(db: DB, actor: Actor, orderIds: number[], reason: string) {
  if (!reason?.trim()) throw new HttpError(400, "A reason is required for reprints");
  const rows = await db
    .update(orders)
    // Clearing the job id means a late duplicate confirmation of the old job cannot cancel the reprint.
    .set({ labelStatus: "unprinted", reservedUntil: null, printJobId: null })
    .where(and(inList(orders.id, orderIds), eq(orders.labelStatus, "printed"), printableBase))
    .returning({ id: orders.id })
    .all();
  await addEvents(db, rows.map((r) => ({ orderId: r.id, event: "reprint_requested", note: reason.trim() })), actor);
  return { requeued: rows.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// Sorting (scan at the packing table)

export type ScanKind = "sorted" | "duplicate" | "cancelled" | "already_dispatched" | "not_booked" | "old_label" | "unknown";
export type ScanResult = {
  kind: ScanKind;
  ok: boolean;
  message: string;
  order?: { id: number; name: string; customer: string | null; phone: string | null; city: string | null; cod: number; items: number; consignmentId: string | null; trackingCode: string | null; sortedAt?: string | null; sortedBy?: string | null };
};

/** Resolves a scanned barcode: Steadfast consignment ID first, then tracking code, invoice, order number. */
async function resolveScan(db: DB, raw: string) {
  const code = raw.trim().replace(/\s+/g, "");
  if (!code) return null;
  const byCid = await db.select().from(consignments).where(eq(consignments.consignmentId, code)).orderBy(desc(consignments.id)).get();
  if (byCid) return byCid;
  const byTracking = await db.select().from(consignments).where(sql`upper(${consignments.trackingCode}) = ${code.toUpperCase()}`).orderBy(desc(consignments.id)).get();
  if (byTracking) return byTracking;
  const byInvoice = await db.select().from(consignments).where(eq(consignments.invoice, code)).get();
  if (byInvoice) return byInvoice;
  const order = await db.select({ active: orders.activeConsignmentId }).from(orders).where(sql`${orders.name} in (${code}, ${"#" + code.replace(/^#/, "")})`).get();
  if (order?.active) return (await db.select().from(consignments).where(eq(consignments.id, order.active)).get()) ?? null;
  return null;
}

/**
 * One label scan. Marks the parcel "sorted" (ready for courier pickup) exactly once.
 * Dispatch itself is recorded only when Steadfast reports the pickup.
 */
export async function scanParcel(db: DB, actor: Actor, code: string, batchId: string | null): Promise<ScanResult> {
  const c = await resolveScan(db, code);
  if (!c) return { kind: "unknown", ok: false, message: `No parcel found for "${code.trim()}"` };
  const o = await db.select().from(orders).where(eq(orders.id, c.orderId)).get();
  if (!o) return { kind: "unknown", ok: false, message: "Order not found" };
  const info = {
    id: o.id,
    name: o.name,
    customer: c.recipientName || o.customerName,
    phone: c.recipientPhone || o.phone,
    city: o.city,
    cod: c.codAmount,
    items: (c.lineItems?.length ? c.lineItems : o.lineItems).reduce((sum, li) => sum + li.quantity, 0),
    consignmentId: c.consignmentId,
    trackingCode: c.trackingCode,
    sortedAt: o.sortedAt,
    sortedBy: o.sortedBy,
  };
  if (c.superseded || o.activeConsignmentId !== c.id) {
    return { kind: "old_label", ok: false, message: "Old label — this order was rebooked. Use the new label.", order: info };
  }
  if (o.cancelledAt) return { kind: "cancelled", ok: false, message: "STOP — order cancelled in Shopify. Keep this parcel.", order: info };
  // A combined parcel: one of the other orders inside it was cancelled, so the contents and COD are wrong.
  const cancelledInside = await db
    .select({ name: orders.name })
    .from(orders)
    .where(and(eq(orders.activeConsignmentId, c.id), sql`${orders.combinedIntoOrderId} is not null and ${orders.cancelledAt} is not null`))
    .all();
  if (cancelledInside.length) {
    return { kind: "cancelled", ok: false, message: `STOP — ${cancelledInside.map((x) => x.name).join(", ")} in this parcel was cancelled. Repack and fix the COD.`, order: info };
  }
  if (o.dispatchStatus === "dispatched" || !["booked"].includes(o.courierStage)) {
    if (["in_transit", "on_hold", "awaiting_confirmation", "delivered", "partial_delivered", "returned"].includes(o.courierStage) || o.dispatchStatus === "dispatched") {
      return { kind: "already_dispatched", ok: false, message: "Already picked up by Steadfast", order: info };
    }
    return { kind: "not_booked", ok: false, message: `Not bookable state (${o.courierStage})`, order: info };
  }
  const now = nowIso();
  const row = await db
    .update(orders)
    .set({
      dispatchStatus: "sorted",
      sortedAt: now,
      sortedBy: actor.name,
      sortBatchId: batchId,
      // A scanned label physically exists, so it can never be handed to the printer again.
      labelStatus: "printed",
      printedAt: sql`coalesce(${orders.printedAt}, ${now})`,
      reservedUntil: null,
    })
    .where(and(eq(orders.id, o.id), eq(orders.dispatchStatus, "pending")))
    .returning({ id: orders.id })
    .get();
  if (!row) {
    const fresh = await db.select({ sortedAt: orders.sortedAt, sortedBy: orders.sortedBy }).from(orders).where(eq(orders.id, o.id)).get();
    return { kind: "duplicate", ok: true, message: `Already sorted${fresh?.sortedBy ? ` by ${fresh.sortedBy}` : ""}`, order: { ...info, ...fresh } };
  }
  await addEvents(db, [{ orderId: o.id, event: "sorted", jobId: batchId, consignmentRowId: c.id }], actor);
  if (batchId) await db.update(sortBatches).set({ scannedCount: sql`${sortBatches.scannedCount} + 1` }).where(eq(sortBatches.id, batchId));
  return { kind: "sorted", ok: true, message: "Sorted — ready for pickup", order: { ...info, sortedAt: now, sortedBy: actor.name } };
}

/** Manual (no scanner) sorting from the dashboard or API. */
export async function markSorted(db: DB, actor: Actor, orderIds: number[]) {
  const results: { orderId: number; result: string }[] = [];
  for (const id of orderIds) {
    const o = await db.select({ cid: consignments.consignmentId, tracking: consignments.trackingCode, invoice: consignments.invoice }).from(orders).innerJoin(consignments, eq(consignments.id, orders.activeConsignmentId)).where(eq(orders.id, id)).get();
    if (!o) {
      results.push({ orderId: id, result: "not_booked" });
      continue;
    }
    const r = await scanParcel(db, actor, o.cid ?? o.tracking ?? o.invoice, null);
    results.push({ orderId: id, result: r.kind });
  }
  return { sorted: results.filter((r) => r.result === "sorted").length, results };
}

export async function unsort(db: DB, actor: Actor, orderIds: number[], reason: string) {
  const rows = await db
    .update(orders)
    .set({ dispatchStatus: "pending", sortedAt: null, sortedBy: null, sortBatchId: null, pickupId: null, handedOverAt: null })
    .where(and(inList(orders.id, orderIds), eq(orders.dispatchStatus, "sorted")))
    .returning({ id: orders.id })
    .all();
  await addEvents(db, rows.map((r) => ({ orderId: r.id, event: "unsorted", note: reason })), actor);
  return { reverted: rows.map((r) => r.id) };
}

const toSortSql = sql`${orders.courierStage} = 'booked' and ${orders.cancelledAt} is null and ${orders.archived} = 0 and ${orders.dispatchStatus} = 'pending' and ${orders.activeConsignmentId} is not null and ${orders.combinedIntoOrderId} is null`;

export async function startBatch(db: DB, actor: Actor, name?: string) {
  const id = crypto.randomUUID();
  await db.insert(sortBatches).values({ id, name: name?.trim() || `Pickup ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, startedBy: actor.name, startedAt: nowIso() });
  return id;
}

/** Live picture of a scanning session: scanned in this batch, and parcels still waiting to be sorted. */
export async function batchSummary(db: DB, batchId: string | null) {
  const batch = batchId ? await db.select().from(sortBatches).where(eq(sortBatches.id, batchId)).get() : null;
  const cols = { id: orders.id, name: orders.name, customer: orders.customerName, city: orders.city, sortedAt: orders.sortedAt, cid: consignments.consignmentId };
  const scanned = batchId
    ? await db.select(cols).from(orders).leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId)).where(eq(orders.sortBatchId, batchId)).orderBy(desc(orders.sortedAt)).limit(500).all()
    : [];
  const remaining = await db.select(cols).from(orders).leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId)).where(toSortSql).orderBy(orders.bookedAt).limit(500).all();
  const totals = await db
    .select({
      toSort: sql<number>`sum(case when ${toSortSql} then 1 else 0 end)`,
      sortedWaiting: sql<number>`sum(case when ${orders.dispatchStatus} = 'sorted' and ${orders.cancelledAt} is null then 1 else 0 end)`,
      sortedCancelled: sql<number>`sum(case when ${orders.dispatchStatus} = 'sorted' and ${orders.cancelledAt} is not null then 1 else 0 end)`,
    })
    .from(orders)
    .get();
  return {
    batch,
    scanned,
    remaining,
    totals: { toSort: Number(totals?.toSort ?? 0), sortedWaiting: Number(totals?.sortedWaiting ?? 0), sortedCancelled: Number(totals?.sortedCancelled ?? 0) },
  };
}

export async function closeBatch(db: DB, batchId: string) {
  await db.update(sortBatches).set({ closedAt: nowIso() }).where(and(eq(sortBatches.id, batchId), sql`${sortBatches.closedAt} is null`));
}

// ---------------------------------------------------------------------------
// Summary & history

export async function summary(db: DB, range: { from: string; to: string }) {
  const inDay = (col: AnyColumn) => sql`${col} >= ${range.from} and ${col} < ${range.to}`;
  const cohort = await db
    .select({
      booked: sql<number>`count(*)`,
      unprinted: sql<number>`sum(case when ${orders.labelStatus} = 'unprinted' and ${orders.courierStage} = 'booked' and ${orders.cancelledAt} is null then 1 else 0 end)`,
      reserved: sql<number>`sum(case when ${orders.labelStatus} = 'reserved' then 1 else 0 end)`,
      printed: sql<number>`sum(case when ${orders.labelStatus} = 'printed' then 1 else 0 end)`,
      awaitingSort: sql<number>`sum(case when ${orders.dispatchStatus} = 'pending' and ${orders.courierStage} = 'booked' and ${orders.cancelledAt} is null then 1 else 0 end)`,
      sorted: sql<number>`sum(case when ${orders.dispatchStatus} = 'sorted' then 1 else 0 end)`,
      dispatched: sql<number>`sum(case when ${orders.dispatchStatus} = 'dispatched' then 1 else 0 end)`,
      cancelledAfterBooking: sql<number>`sum(case when ${orders.cancelledAt} is not null then 1 else 0 end)`,
    })
    .from(orders)
    .where(and(inDay(orders.bookedAt), sql`${orders.activeConsignmentId} is not null and ${orders.combinedIntoOrderId} is null`))
    .get();
  const confirmed = (await db.select({ n: sql<number>`count(*)` }).from(orders).where(inDay(orders.confirmedAt)).get())?.n ?? 0;
  const printedThatDay = (await db.select({ n: sql<number>`count(*)` }).from(orders).where(inDay(orders.printedAt)).get())?.n ?? 0;
  // Carry-over across all days, for next-day dispatch.
  const backlog = await db
    .select({
      unprinted: sql<number>`sum(case when ${orders.labelStatus} = 'unprinted' then 1 else 0 end)`,
      reserved: sql<number>`sum(case when ${orders.labelStatus} = 'reserved' then 1 else 0 end)`,
      awaitingSort: sql<number>`sum(case when ${orders.dispatchStatus} = 'pending' then 1 else 0 end)`,
      awaitingPickup: sql<number>`sum(case when ${orders.dispatchStatus} = 'sorted' then 1 else 0 end)`,
    })
    .from(orders)
    .where(printableBase)
    .get();
  const n = (v: unknown) => Number(v ?? 0);
  return {
    confirmedOrders: confirmed,
    bookedConsignments: n(cohort?.booked),
    unprinted: n(cohort?.unprinted),
    reserved: n(cohort?.reserved),
    printed: n(cohort?.printed),
    printedOnDate: printedThatDay,
    awaitingSort: n(cohort?.awaitingSort),
    sorted: n(cohort?.sorted),
    dispatched: n(cohort?.dispatched),
    cancelledAfterBooking: n(cohort?.cancelledAfterBooking),
    backlog: {
      unprinted: n(backlog?.unprinted),
      reserved: n(backlog?.reserved),
      awaitingSort: n(backlog?.awaitingSort),
      awaitingPickup: n(backlog?.awaitingPickup),
    },
  };
}

export async function listJobs(db: DB, limit = 50) {
  return db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(limit).all();
}

export async function orderHistory(db: DB, orderId: number) {
  return db.select().from(dispatchEvents).where(eq(dispatchEvents.orderId, orderId)).orderBy(desc(dispatchEvents.createdAt), desc(dispatchEvents.id)).all();
}
