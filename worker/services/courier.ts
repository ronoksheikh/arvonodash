import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { inList, type DB } from "../db";
import type { Env, SessionUser } from "../env";
import { consignments, customers, customStatuses, orders, returns, trackingEvents, type BookingDetails } from "../db/schema";
import * as steadfast from "./steadfast";
import { enqueueJob } from "./jobs";
import { getSettings, type AppSettings } from "./settings";
import { logActivity, type Actor } from "./activity";
import { buildAddress, refreshRiskFlags, shopifyContactKey } from "./orders";
import { onBooked, onCourierReceived, onNotPrintable } from "./dispatch";
import { shipByDate } from "./pickup";
import { queueSms } from "./sms";
import { HttpError, normalizeBdPhone, nowIso, toNumber, truncate } from "../lib/util";
import { partialOutcome } from "../../shared/delivery";

type OrderRow = typeof orders.$inferSelect;

/**
 * A parcel whose COD is still out there: really booked, not finished, not replaced by a rebooking,
 * and not cancelled (or on its way to being cancelled) or deleted. Used by every money total.
 */
export const OPEN_PARCEL_SQL = sql`(${consignments.isFinal} = 0 and ${consignments.superseded} = 0 and ${consignments.consignmentId} is not null
  and ${consignments.stage} not in ('cancelled', 'returned') and ${consignments.status} not like 'cancelled%' and ${consignments.status} != 'deleted')`;

/** A consignment that really left with Steadfast's booking: not a failed booking, not cancelled or deleted before pickup. */
export const REAL_PARCEL_SQL = sql`(${consignments.consignmentId} is not null and ${consignments.stage} != 'cancelled')`;
type ConsignmentRow = typeof consignments.$inferSelect;

/** Booking details shown in the editor: saved edits layered over values derived from the order. */
export function defaultBooking(order: OrderRow, appSettings: AppSettings): BookingDetails {
  const items = order.lineItems.map((li) => `${li.quantity}x ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ""}`).join(", ");
  return {
    recipientName: order.customerName ?? "",
    recipientPhone: order.phone ?? order.rawPhone ?? "",
    recipientEmail: order.email ?? undefined,
    recipientAddress: truncate(buildAddress(order), 250),
    codAmount: Math.max(0, Math.round(order.outstanding)),
    note: appSettings.defaultNote || undefined,
    itemDescription: appSettings.includeItemsInDescription ? truncate(items, 250) : undefined,
    totalLot: order.lineItems.reduce((s, li) => s + li.quantity, 0) || undefined,
    deliveryType: 0,
  };
}

export function effectiveBooking(order: OrderRow, appSettings: AppSettings): BookingDetails {
  return { ...defaultBooking(order, appSettings), ...(order.booking ?? {}) } as BookingDetails;
}

export function validateBooking(b: BookingDetails): string[] {
  const errors: string[] = [];
  if (!b.recipientName?.trim()) errors.push("Recipient name is required");
  if (b.recipientName && b.recipientName.length > 100) errors.push("Recipient name must be at most 100 characters");
  if (!normalizeBdPhone(b.recipientPhone)) errors.push("Recipient phone must be a valid 11-digit Bangladeshi mobile number");
  if (b.alternativePhone && !normalizeBdPhone(b.alternativePhone)) errors.push("Alternative phone must be a valid 11-digit mobile number");
  if (!b.recipientAddress?.trim()) errors.push("Recipient address is required");
  if (b.recipientAddress && b.recipientAddress.length > 250) errors.push("Address must be at most 250 characters");
  if (!(toNumber(b.codAmount, -1) >= 0)) errors.push("COD amount must be 0 or more");
  return errors;
}

/** Invoice = prefix + order number (+ the other order numbers of a combined parcel), unique per attempt. */
function invoiceFor(order: OrderRow, appSettings: AppSettings, attempt: number, extras: OrderRow[] = []): string {
  const numbers = [order, ...extras].map((o) => o.name.replace(/^#/, "")).join("_");
  const base = `${appSettings.invoicePrefix}${numbers}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 90);
  return attempt > 0 ? `${base}-R${attempt}` : base;
}

/** Why an order can't be booked right now, or null. */
function bookingBlocker(order: OrderRow, blockingStatuses: Set<number>): string | null {
  if (order.cancelledAt) return "is cancelled in Shopify";
  if (order.callingStatus !== "confirmed") return "is not confirmed yet — call the customer first";
  if (order.courierStage !== "unbooked" && order.courierStage !== "cancelled" && order.courierStage !== "returned") return "already has an active consignment";
  if (order.combinedIntoOrderId) return "already travels in another order's parcel";
  if (order.statusId && blockingStatuses.has(order.statusId)) return "has a status that blocks booking";
  if (order.shopifyFulfillmentStatus === "fulfilled" && order.fulfillmentState !== "fulfilled") return "is already fulfilled in Shopify";
  return null;
}

export type BookingResult = { orderId: number; name?: string; ok: boolean; error?: string; trackingCode?: string; consignmentId?: string; combinedWith?: string[] };
export type BookOptions = { override?: Partial<BookingDetails>; allowRisky?: boolean; combine?: boolean };

/**
 * Creates Steadfast consignments for the given orders. Only ever called from an explicit staff action.
 * Duplicate bookings are prevented by (1) refusing orders with an active consignment and
 * (2) a unique invoice per attempt, enforced both in D1 and by Steadfast.
 */
export async function bookOrders(
  env: Env,
  db: DB,
  user: SessionUser,
  orderIds: number[],
  opts: BookOptions = {},
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<BookingResult[]> {
  const appSettings = await getSettings(db);
  const blockingStatuses = new Set(
    (await db.select({ id: customStatuses.id }).from(customStatuses).where(eq(customStatuses.blocksBooking, true)).all()).map((s) => s.id),
  );
  const rows = await db.select().from(orders).where(inList(orders.id, orderIds)).all();
  const results: BookingResult[] = orderIds.filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ orderId: id, ok: false, error: "Order not found" }));

  // With `combine`, a customer's orders (same phone) travel as one parcel: the oldest order owns it.
  const parcels: OrderRow[][] = [];
  if (opts.combine) {
    const byPhone = new Map<string, OrderRow[]>();
    for (const r of [...rows].sort((a, b) => a.shopCreatedAt.localeCompare(b.shopCreatedAt))) {
      const key = r.phone ?? `order:${r.id}`;
      byPhone.set(key, [...(byPhone.get(key) ?? []), r]);
    }
    parcels.push(...byPhone.values());
  } else {
    parcels.push(...rows.map((r) => [r]));
  }

  const queue = [...parcels];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      const [primary, ...extras] = group;
      const r = await bookOne(env, db, user, primary, appSettings, blockingStatuses, opts, extras);
      results.push(r);
      for (const x of extras) {
        results.push(r.ok ? { orderId: x.id, name: x.name, ok: true, trackingCode: r.trackingCode, consignmentId: r.consignmentId, combinedWith: [primary.name] } : { orderId: x.id, name: x.name, ok: false, error: r.error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, parcels.length) }, worker));

  const booked = results.filter((r) => r.ok).length;
  if (booked) waitUntil?.(import("./jobs").then((m) => m.processJobs(env, db, { limit: booked * 2 })));
  return results;
}

async function bookOne(
  env: Env,
  db: DB,
  user: SessionUser,
  order: OrderRow,
  appSettings: AppSettings,
  blockingStatuses: Set<number>,
  opts: BookOptions,
  extras: OrderRow[] = [],
): Promise<BookingResult> {
  const base = { orderId: order.id, name: order.name };
  for (const x of extras) {
    const why = bookingBlocker(x, blockingStatuses) ?? (x.phone !== order.phone ? "is for a different customer" : x.activeConsignmentId ? "already has a parcel" : null);
    if (why) return { ...base, ok: false, error: `Can't combine with ${x.name}: ${why}` };
  }
  const blocker = bookingBlocker(order, blockingStatuses);
  if (blocker) return { ...base, ok: false, error: `Order ${blocker}` };

  const existing = await db
    .select()
    .from(consignments)
    .where(and(eq(consignments.orderId, order.id), eq(consignments.superseded, false)))
    .all();
  if (existing.some((c) => c.stage !== "cancelled")) return { ...base, ok: false, error: "Order already has an active consignment" };

  if (!opts.allowRisky && order.customerId) {
    const customer = await db.select({ flag: customers.flag }).from(customers).where(eq(customers.id, order.customerId)).get();
    if (customer?.flag === "blocked") return { ...base, ok: false, error: "Customer is blocked" };
  }

  const booking = { ...effectiveBooking(order, appSettings), ...(opts.override ?? {}) };
  if (extras.length) {
    if (booking.lineItems?.length) return { ...base, ok: false, error: "A partial shipment can't be combined with other orders" };
    const all = [order, ...extras];
    // This order's COD (possibly edited by staff) plus each combined order's own COD.
    booking.codAmount = toNumber(booking.codAmount) + extras.reduce((sum, x) => sum + toNumber(effectiveBooking(x, appSettings).codAmount), 0);
    booking.totalLot = all.reduce((sum, o) => sum + o.lineItems.reduce((q, li) => q + li.quantity, 0), 0) || undefined;
    if (appSettings.includeItemsInDescription) {
      booking.itemDescription = truncate(all.map((o) => `${o.name}: ${o.lineItems.map((li) => `${li.quantity}x ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ""}`).join(", ")}`).join(" | "), 250);
    }
    booking.note = truncate([`Combined parcel: ${all.map((o) => o.name).join(" + ")}`, booking.note].filter(Boolean).join(". "), 480);
  }
  booking.recipientPhone = normalizeBdPhone(booking.recipientPhone) ?? booking.recipientPhone;
  if (booking.alternativePhone) booking.alternativePhone = normalizeBdPhone(booking.alternativePhone) ?? booking.alternativePhone;
  const errors = validateBooking(booking);
  if (errors.length) return { ...base, ok: false, error: errors.join("; ") };

  const attempt = (await db.select({ n: sql<number>`count(*)` }).from(consignments).where(eq(consignments.orderId, order.id)).get())?.n ?? 0;
  const invoice = invoiceFor(order, appSettings, attempt, extras);
  const now = nowIso();

  // Reserve the invoice first; the unique index stops concurrent double-booking.
  const reserved = await db
    .insert(consignments)
    .values({
      orderId: order.id,
      invoice,
      status: "creating",
      stage: "booked",
      recipientName: booking.recipientName,
      recipientPhone: booking.recipientPhone,
      recipientAddress: booking.recipientAddress,
      codAmount: toNumber(booking.codAmount),
      note: booking.note ?? null,
      deliveryType: booking.deliveryType ?? 0,
      lineItems: booking.lineItems?.length ? booking.lineItems : null,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!reserved) return { ...base, ok: false, error: "A booking for this order is already in progress" };

  // Claim the combined orders before calling Steadfast, so no other booking can take them meanwhile.
  if (extras.length) {
    const claimed = await db
      .update(orders)
      .set({ activeConsignmentId: reserved.id, combinedIntoOrderId: order.id })
      .where(and(inList(orders.id, extras.map((x) => x.id)), isNull(orders.activeConsignmentId), isNull(orders.combinedIntoOrderId), isNull(orders.cancelledAt)))
      .returning({ id: orders.id })
      .all();
    if (claimed.length !== extras.length) {
      await detachCombined(db, reserved.id);
      await db.delete(consignments).where(eq(consignments.id, reserved.id));
      return { ...base, ok: false, error: "One of the orders to combine changed meanwhile; try again" };
    }
  }

  let created: steadfast.CreatedConsignment;
  try {
    created = await steadfast.createOrder(env, {
      invoice,
      recipient_name: booking.recipientName.trim(),
      recipient_phone: booking.recipientPhone,
      alternative_phone: booking.alternativePhone || undefined,
      recipient_email: booking.recipientEmail || undefined,
      recipient_address: booking.recipientAddress.trim(),
      cod_amount: toNumber(booking.codAmount),
      note: booking.note || undefined,
      item_description: booking.itemDescription || undefined,
      total_lot: booking.totalLot || undefined,
      delivery_type: booking.deliveryType ?? 0,
    });
  } catch (err) {
    const definite = err instanceof HttpError && (err.status === 422 || err.status === 502 || err.status === 503 && /not configured/.test(err.message));
    if (definite) {
      await detachCombined(db, reserved.id);
      await db.delete(consignments).where(eq(consignments.id, reserved.id));
    } else {
      // Outcome unknown (timeout etc.): keep the reservation so the poller can reconcile by invoice.
      await db.update(consignments).set({ status: "unconfirmed", stage: "issue", lastMessage: (err as Error).message }).where(eq(consignments.id, reserved.id));
      await db.update(orders).set({ courierStage: "issue", activeConsignmentId: reserved.id }).where(eq(orders.id, order.id));
    }
    await logActivity(db, user, "courier.booking_failed", { entityType: "order", entityId: order.id, orderId: order.id, details: { invoice, error: (err as Error).message } });
    return { ...base, ok: false, error: (err as Error).message };
  }

  const consignmentId = String(created.consignment_id);
  await db
    .update(consignments)
    .set({ consignmentId, trackingCode: created.tracking_code, status: created.status || "in_review", lastStatusAt: now, updatedAt: nowIso() })
    .where(eq(consignments.id, reserved.id));
  for (const c of existing) await db.update(consignments).set({ superseded: true }).where(eq(consignments.id, c.id));
  await db
    .update(orders)
    .set({ courierStage: "booked", activeConsignmentId: reserved.id, booking: booking, bookedSource: shopifyContactKey(order), autoBookAt: null, autoBookNote: null, updatedAt: nowIso() })
    .where(eq(orders.id, order.id));
  // Same-day dispatch: ready before the cut-off → leaves with today's pickup, otherwise tomorrow's.
  const readyAt = [order.confirmedAt, ...extras.map((x) => x.confirmedAt), now].filter((t): t is string => Boolean(t)).sort()[0];
  await onBooked(db, order.id, reserved.id, user, shipByDate(readyAt, appSettings.cutoffTime, env.APP_TIMEZONE_OFFSET || "+06:00"));
  for (const x of extras) {
    // The parcel (label, scan, pickup) belongs to the primary order; combined orders follow it.
    await db
      .update(orders)
      .set({ courierStage: "booked", bookedAt: now, bookedSource: shopifyContactKey(x), autoBookAt: null, autoBookNote: `Travels in the parcel of ${order.name}`, updatedAt: nowIso() })
      .where(eq(orders.id, x.id));
    if (appSettings.shopifyBookedTag) {
      await enqueueJob(db, "shopify_tag", `tag:${x.id}:${reserved.id}`, { shopifyOrderId: x.shopifyId, tags: [appSettings.shopifyBookedTag] });
    }
    if (appSettings.fulfillmentTrigger === "on_booking") await queueFulfillment(db, x.id, reserved.id);
  }
  await db.insert(trackingEvents).values({
    consignmentRowId: reserved.id,
    orderId: order.id,
    kind: "system",
    status: created.status || "in_review",
    message: `Booked with Steadfast by ${user.name} (invoice ${invoice}, COD ৳${toNumber(booking.codAmount)}${extras.length ? `, combined with ${extras.map((x) => x.name).join(", ")}` : ""})`,
    source: "api",
    occurredAt: now,
    createdAt: now,
  });
  await logActivity(db, user, "courier.booked", {
    entityType: "consignment",
    entityId: consignmentId,
    orderId: order.id,
    details: { invoice, trackingCode: created.tracking_code, cod: booking.codAmount, combined: extras.map((x) => x.name) },
  });

  if (appSettings.shopifyBookedTag) {
    await enqueueJob(db, "shopify_tag", `tag:${order.id}:${reserved.id}`, { shopifyOrderId: order.shopifyId, tags: [appSettings.shopifyBookedTag] });
  }
  if (appSettings.fulfillmentTrigger === "on_booking") await queueFulfillment(db, order.id, reserved.id);

  return { ...base, ok: true, trackingCode: created.tracking_code, consignmentId, combinedWith: extras.map((x) => x.name) };
}

/** Releases orders that were combined into a parcel (booking failed, discarded or released). */
export async function detachCombined(db: DB, consignmentRowId: number) {
  return db
    .update(orders)
    .set({ courierStage: "unbooked", activeConsignmentId: null, combinedIntoOrderId: null, bookedAt: null, bookedSource: null, dispatchStatus: "pending", dispatchedAt: null, courierReceivedAt: null, updatedAt: nowIso() })
    .where(and(eq(orders.activeConsignmentId, consignmentRowId), isNotNull(orders.combinedIntoOrderId)))
    .returning({ id: orders.id })
    .all();
}

export async function queueFulfillment(db: DB, orderId: number, consignmentRowId: number, reset = false) {
  await db.update(orders).set({ fulfillmentState: "pending", fulfillmentError: null }).where(and(eq(orders.id, orderId), sql`${orders.fulfillmentState} != 'fulfilled'`));
  return enqueueJob(db, "fulfill_order", `fulfill:${orderId}:${consignmentRowId}`, { orderId, consignmentRowId }, { reset });
}

/**
 * Applies a status/tracking update for a consignment from a webhook, poll or manual refresh.
 * Returns true when anything changed.
 */
export async function applyCourierUpdate(
  db: DB,
  c: ConsignmentRow,
  update: { status?: string | null; message?: string | null; codAmount?: number | null; deliveryCharge?: number | null; occurredAt?: string | null; source: "webhook" | "poll" | "manual" },
  actor: Actor = "steadfast",
): Promise<boolean> {
  const now = nowIso();
  const occurredAt = steadfast.parseSteadfastTime(update.occurredAt) ?? now;
  const newStatus = update.status?.toLowerCase().trim() || null;
  const statusChanged = Boolean(newStatus && newStatus !== c.status);

  if (!statusChanged && !update.message) {
    await db.update(consignments).set({ lastPolledAt: now }).where(eq(consignments.id, c.id));
    return false;
  }

  // Ignore a late webhook carrying an older status than what we already have.
  if (statusChanged && c.lastStatusAt && occurredAt < c.lastStatusAt && update.source === "webhook" && c.isFinal) {
    await db.insert(trackingEvents).values({ consignmentRowId: c.id, orderId: c.orderId, kind: "status", status: newStatus, message: "Out-of-order update ignored", source: update.source, occurredAt, createdAt: now });
    return false;
  }

  const patch: Partial<ConsignmentRow> = { updatedAt: now, lastPolledAt: now };
  if (update.message) patch.lastMessage = update.message;
  if (update.deliveryCharge !== null && update.deliveryCharge !== undefined) patch.deliveryCharge = update.deliveryCharge;

  let stage = c.stage;
  const firstPickup = Boolean(statusChanged && !c.pickedUpAt && steadfast.isPickedUpStatus(newStatus!));
  if (statusChanged) {
    const pickedUp = Boolean(c.pickedUpAt) || steadfast.isPickedUpStatus(newStatus!);
    stage = steadfast.stageForStatus(newStatus!, pickedUp);
    Object.assign(patch, { status: newStatus!, stage, lastStatusAt: occurredAt, isFinal: steadfast.isFinalStatus(newStatus!) });
    if (firstPickup) patch.pickedUpAt = occurredAt;
    if ((stage === "delivered" || stage === "partial_delivered") && !c.deliveredAt) patch.deliveredAt = occurredAt;
    if (stage === "returned" && !c.returnedAt) patch.returnedAt = occurredAt;
    if (stage === "delivered" || stage === "partial_delivered") {
      patch.collectedAmount = update.codAmount ?? (stage === "delivered" ? c.codAmount : c.collectedAmount);
    }
    if (stage === "returned" || stage === "cancelled") patch.collectedAmount = update.codAmount ?? 0;
  }
  await db.update(consignments).set(patch).where(eq(consignments.id, c.id));

  await db.insert(trackingEvents).values({
    consignmentRowId: c.id,
    orderId: c.orderId,
    kind: statusChanged ? "status" : "tracking",
    status: statusChanged ? newStatus : null,
    message: update.message ?? null,
    source: update.source,
    occurredAt,
    createdAt: now,
  });

  if (!statusChanged) return true;

  await logActivity(db, actor, "courier.status", {
    entityType: "consignment",
    entityId: c.consignmentId ?? c.invoice,
    orderId: c.orderId,
    details: { from: c.status, to: newStatus, source: update.source },
  });

  const appSettings = await getSettings(db);
  // A parcel can carry several orders of the same customer (combined booking): update each of them.
  for (const order of await parcelOrders(db, c)) {
    if (order.activeConsignmentId === c.id || (order.activeConsignmentId === null && !c.superseded)) {
      await db.update(orders).set({ courierStage: stage, activeConsignmentId: c.id, updatedAt: now }).where(eq(orders.id, order.id));
    }
    if (firstPickup) await onCourierReceived(db, order.id, c.id, occurredAt);
    if (stage === "cancelled") await onNotPrintable(db, order.id, "Consignment cancelled before pickup", { name: "steadfast" });
    // Parcel finished: parcel-level warnings (deleted/cancelled in Shopify, COD mismatch) no longer apply.
    if (steadfast.isFinalStatus(newStatus!)) await refreshRiskFlags(db, order.id, appSettings);

    const trigger = appSettings.fulfillmentTrigger;
    const shouldFulfill =
      order.fulfillmentState !== "fulfilled" &&
      order.fulfillmentState !== "skipped" &&
      ((trigger === "on_pickup" && (firstPickup || (steadfast.isPickedUpStatus(newStatus!) && order.fulfillmentState === "none"))) ||
        (trigger === "on_delivery" && (stage === "delivered" || stage === "partial_delivered")));
    if (shouldFulfill && c.trackingCode) await queueFulfillment(db, order.id, c.id);

    // Steadfast confirmed the delivery: the COD is owed to us, so Shopify should show the order as paid.
    if (stage === "delivered" && appSettings.markPaidOnDelivery && order.outstanding > 0) {
      await enqueueJob(db, "shopify_mark_paid", `paid:${order.id}`, { orderId: order.id, consignmentRowId: c.id });
    }
  }

  // Customer SMS: one per parcel (sent for the order that owns it; it names every order inside).
  const smsMoment = firstPickup ? "dispatched" : stage === "delivered" ? "delivered" : stage === "on_hold" || stage === "returned" ? stage : null;
  if (smsMoment) await queueSms(db, c.orderId, smsMoment, appSettings);

  if (appSettings.autoCreateReturns && (stage === "returned" || stage === "partial_delivered")) {
    const existingReturn = await db.select({ id: returns.id }).from(returns).where(eq(returns.consignmentRowId, c.id)).get();
    if (!existingReturn) {
      const order = await db.select({ lineItems: orders.lineItems }).from(orders).where(eq(orders.id, c.orderId)).get();
      const collected = patch.collectedAmount ?? c.collectedAmount;
      const chargeOnly = stage === "partial_delivered" && partialOutcome(collected, order?.lineItems ?? []) === "charge_only";
      await db.insert(returns).values({
        orderId: c.orderId,
        consignmentRowId: c.id,
        type: stage === "returned" ? "courier_return" : "partial_return",
        reason:
          stage === "returned"
            ? (update.message ?? "Delivery failed / cancelled by courier")
            : chargeOnly
              ? `Customer paid only the delivery charge (৳${toNumber(collected)}) and returned the product`
              : (update.message ?? "Partially delivered — some items returned"),
        status: "expected",
        followUpAction: "call_customer",
        createdAt: now,
        updatedAt: now,
      });
      await logActivity(db, "system", "return.created", { entityType: "order", entityId: c.orderId, orderId: c.orderId, details: { stage, chargeOnly } });
    }
  }
  return true;
}

/**
 * Steadfast no longer has this parcel (deleted in the portal before pickup; afterwards it answers
 * "unknown" or "not found"). Recorded as its own final status so it never shows as a courier problem,
 * and the order goes back to "To book" if it is still wanted (cancelled orders just stop here).
 */
export async function onDeletedInSteadfast(db: DB, c: ConsignmentRow) {
  const now = nowIso();
  const row = await db
    .update(consignments)
    .set({ status: "deleted", stage: "cancelled", isFinal: true, lastStatusAt: now, lastPolledAt: now, lastMessage: "Deleted in the Steadfast portal", collectedAmount: 0, updatedAt: now })
    .where(and(eq(consignments.id, c.id), sql`${consignments.status} != 'deleted'`, isNull(consignments.pickedUpAt)))
    .returning({ id: consignments.id })
    .get();
  if (!row) return false;
  await db.insert(trackingEvents).values({ consignmentRowId: c.id, orderId: c.orderId, kind: "status", status: "deleted", message: "Parcel no longer exists in Steadfast (deleted in the portal before pickup)", source: "poll", occurredAt: now, createdAt: now });
  await logActivity(db, "steadfast", "consignment.deleted_in_steadfast", { entityType: "consignment", entityId: c.consignmentId ?? c.invoice, orderId: c.orderId, details: { from: c.status } });
  for (const order of await parcelOrders(db, c)) {
    if (order.activeConsignmentId !== c.id) continue;
    await db.update(orders).set({ courierStage: "cancelled", updatedAt: now }).where(eq(orders.id, order.id));
    await onNotPrintable(db, order.id, "Parcel deleted in Steadfast", { name: "steadfast" });
    await refreshRiskFlags(db, order.id, await getSettings(db));
  }
  return true;
}

/** The orders a consignment carries: its own order plus any orders combined into the same parcel. */
export async function parcelOrders(db: DB, c: Pick<ConsignmentRow, "id" | "orderId">) {
  return db
    .select()
    .from(orders)
    .where(or(eq(orders.id, c.orderId), and(eq(orders.activeConsignmentId, c.id), isNotNull(orders.combinedIntoOrderId))))
    .all();
}

/** Polls Steadfast for consignments that are not final. Fallback for missed webhooks. */
export async function pollActiveConsignments(env: Env, db: DB, opts: { limit?: number; ids?: number[]; staleMinutes?: number } = {}) {
  const staleBefore = new Date(Date.now() - (opts.staleMinutes ?? 30) * 60_000).toISOString();
  const rows = await db
    .select()
    .from(consignments)
    .where(
      opts.ids
        ? inList(consignments.id, opts.ids)
        : and(
            eq(consignments.isFinal, false),
            eq(consignments.superseded, false),
            sql`(${consignments.lastPolledAt} is null or ${consignments.lastPolledAt} < ${staleBefore})`,
          ),
    )
    .orderBy(sql`${consignments.lastPolledAt} asc nulls first`)
    .limit(opts.limit ?? 40)
    .all();

  let changed = 0;
  let errors = 0;
  for (const c of rows) {
    try {
      if (c.status === "creating" && !c.consignmentId && !c.trackingCode) continue; // booking in flight
      const status = await steadfast.getParcelStatus(env, c);
      if (status === undefined) {
        await db.update(consignments).set({ lastPolledAt: nowIso() }).where(eq(consignments.id, c.id));
        continue;
      }
      const verdict = steadfast.pollVerdict(c, status);
      if (verdict === "deleted") {
        await onDeletedInSteadfast(db, c);
        changed++;
        continue;
      }
      if (verdict === "ignore") {
        // e.g. "unknown" for a parcel that is already cancelled: keep what we have.
        await db.update(consignments).set({ lastPolledAt: nowIso() }).where(eq(consignments.id, c.id));
        continue;
      }
      if (await applyCourierUpdate(db, c, { status, source: "poll" })) {
        changed++;
        // The webhook for this change was missed, so steps in between may be missing too.
        await syncTrackingHistory(env, db, c).catch(() => {});
      } else if (opts.ids) {
        // Manual refresh: fill in any steps we don't have yet.
        await syncTrackingHistory(env, db, c).catch(() => {});
      }
    } catch (err) {
      errors++;
      await db.update(consignments).set({ lastPolledAt: nowIso(), lastMessage: `Poll failed: ${(err as Error).message}` }).where(eq(consignments.id, c.id));
    }
  }
  return { checked: rows.length, changed, errors };
}

/**
 * Copies Steadfast's full step-by-step history for a parcel into our timeline, skipping steps we
 * already have (same text within a few minutes), so missed webhooks leave no gaps.
 */
export async function syncTrackingHistory(env: Env, db: DB, c: Pick<ConsignmentRow, "id" | "orderId" | "invoice" | "consignmentId">) {
  const steps = await steadfast.getTrackingHistory(env, c.invoice);
  if (!steps.length) return { added: 0 };
  const existing = await db.select({ message: trackingEvents.message, at: trackingEvents.occurredAt }).from(trackingEvents).where(eq(trackingEvents.consignmentRowId, c.id)).all();
  const norm = (t: string | null) => (t ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const seen = (text: string, at: string | null) =>
    existing.some((e) => norm(e.message) === norm(text) && (!at || !e.at || Math.abs(Date.parse(e.at) - Date.parse(at)) < 15 * 60_000));
  const now = nowIso();
  let added = 0;
  for (const step of steps) {
    if (step.consignmentId && c.consignmentId && step.consignmentId !== c.consignmentId) continue;
    if (seen(step.text, step.at)) continue;
    await db.insert(trackingEvents).values({ consignmentRowId: c.id, orderId: c.orderId, kind: "tracking", status: null, message: step.text, source: "history", occurredAt: step.at ?? now, createdAt: now });
    existing.push({ message: step.text, at: step.at ?? now });
    added++;
  }
  return { added };
}

export async function findConsignment(db: DB, ref: { consignmentId?: string | null; invoice?: string | null; trackingCode?: string | null }) {
  if (ref.consignmentId) {
    const row = await db.select().from(consignments).where(eq(consignments.consignmentId, ref.consignmentId)).get();
    if (row) return row;
  }
  if (ref.invoice) {
    const row = await db.select().from(consignments).where(eq(consignments.invoice, ref.invoice)).get();
    if (row) {
      // Reconcile a reservation whose create_order response was lost.
      if (!row.consignmentId && ref.consignmentId) {
        await db.update(consignments).set({ consignmentId: ref.consignmentId, status: "in_review" }).where(eq(consignments.id, row.id));
        return { ...row, consignmentId: ref.consignmentId, status: "in_review" };
      }
      return row;
    }
  }
  if (ref.trackingCode) {
    const row = await db.select().from(consignments).where(eq(consignments.trackingCode, ref.trackingCode)).get();
    if (row) return row;
  }
  if (ref.invoice) {
    // Parcels booked before ARVONO use the order number as invoice.
    const order = await db
      .select({ active: orders.activeConsignmentId })
      .from(orders)
      .where(sql`${orders.name} in (${ref.invoice}, ${"#" + ref.invoice.replace(/^#/, "")})`)
      .get();
    if (order?.active) {
      const row = await db.select().from(consignments).where(eq(consignments.id, order.active)).get();
      if (row && !row.consignmentId) {
        if (ref.consignmentId) await db.update(consignments).set({ consignmentId: ref.consignmentId }).where(eq(consignments.id, row.id));
        return { ...row, consignmentId: ref.consignmentId ?? null };
      }
    }
  }
  return null;
}

export async function unbookedCount(db: DB) {
  return (await db.select({ n: sql<number>`count(*)` }).from(orders).where(and(eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt))).get())?.n ?? 0;
}
