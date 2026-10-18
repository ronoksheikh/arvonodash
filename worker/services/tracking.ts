import { and, asc, eq, isNull } from "drizzle-orm";
import type { DB } from "../db";
import { callLogs, consignments, orders, trackingEvents } from "../db/schema";
import { getSettings } from "./settings";

/**
 * Customer-facing order tracking (/t/<token>). The token is 80 random bits, so the link can't be
 * guessed; it only exposes what the customer already knows about their own order (phone masked,
 * no staff names, no internal notes).
 */

export function newTrackingToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the order's tracking token, creating one if it has none yet. */
export async function ensureTrackingToken(db: DB, orderId: number): Promise<string | null> {
  const row = await db.select({ token: orders.trackingToken }).from(orders).where(eq(orders.id, orderId)).get();
  if (!row) return null;
  if (row.token) return row.token;
  await db.update(orders).set({ trackingToken: newTrackingToken() }).where(and(eq(orders.id, orderId), isNull(orders.trackingToken)));
  return (await db.select({ token: orders.trackingToken }).from(orders).where(eq(orders.id, orderId)).get())?.token ?? null;
}

export function trackingPageUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/t/${token}`;
}

export type TrackingTone = "info" | "good" | "warn" | "bad";
export type TrackingEvent = { at: string; kind: string; title: string; detail?: string | null; tone: TrackingTone };
export type TrackingStep = { key: string; label: string; done: boolean; at: string | null };

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return phone;
  return `${digits.slice(0, 3)}${"•".repeat(Math.max(0, digits.length - 6))}${digits.slice(-3)}`;
}

const CALL_EVENTS: Record<string, { title: string; tone: TrackingTone } | undefined> = {
  no_answer: { title: "We called to confirm but couldn't reach you", tone: "warn" },
  call_again: { title: "We'll call you again to confirm", tone: "warn" },
  confirmed: { title: "Order confirmed on the phone", tone: "good" },
  rejected: { title: "Order cancelled on the confirmation call", tone: "bad" },
};

export async function buildTracking(db: DB, token: string) {
  if (!/^[a-f0-9]{16,64}$/.test(token)) return null;
  const order = await db.select().from(orders).where(eq(orders.trackingToken, token)).get();
  if (!order) return null;
  const [calls, cons, events, appSettings] = await Promise.all([
    db.select().from(callLogs).where(eq(callLogs.orderId, order.id)).orderBy(asc(callLogs.createdAt), asc(callLogs.id)).all(),
    db.select().from(consignments).where(eq(consignments.orderId, order.id)).orderBy(asc(consignments.createdAt)).all(),
    db.select().from(trackingEvents).where(eq(trackingEvents.orderId, order.id)).orderBy(asc(trackingEvents.occurredAt), asc(trackingEvents.id)).all(),
    getSettings(db),
  ]);

  const timeline: TrackingEvent[] = [{ at: order.shopCreatedAt, kind: "placed", title: "Order placed", detail: `Order ${order.name}`, tone: "info" }];

  for (const call of calls) {
    const e = CALL_EVENTS[call.outcome];
    if (!e) continue;
    const detail = call.outcome === "call_again" && call.callbackAt ? `Next call around ${call.callbackAt}` : null;
    timeline.push({ at: call.createdAt, kind: `call_${call.outcome}`, title: e.title, detail, tone: e.tone });
  }
  if (order.confirmedAt && !calls.some((c) => c.outcome === "confirmed")) {
    timeline.push({ at: order.confirmedAt, kind: "call_confirmed", title: "Order confirmed", tone: "good" });
  }

  for (const c of cons) {
    if (!c.consignmentId && !c.trackingCode) continue; // reservation that never reached Steadfast
    timeline.push({
      at: c.createdAt,
      kind: "booked",
      title: "Sent to Steadfast Courier",
      detail: c.trackingCode ? `Courier tracking code ${c.trackingCode}` : null,
      tone: "info",
    });
    if (c.pickedUpAt) timeline.push({ at: c.pickedUpAt, kind: "picked_up", title: "Picked up by Steadfast — on the way", tone: "info" });
    if (c.deliveredAt) {
      const partial = c.stage === "partial_delivered";
      timeline.push({ at: c.deliveredAt, kind: "delivered", title: partial ? "Partially delivered" : "Delivered", tone: "good" });
    }
    if (c.returnedAt) timeline.push({ at: c.returnedAt, kind: "returned", title: "Delivery failed — parcel returned", tone: "bad" });
  }
  if (order.sortedAt) timeline.push({ at: order.sortedAt, kind: "packed", title: "Packed and ready for courier pickup", tone: "info" });

  for (const e of events) {
    if (e.kind === "tracking" && e.message) {
      timeline.push({ at: e.occurredAt, kind: "courier_update", title: e.message, tone: "info" });
    } else if (e.kind === "status" && e.status === "hold") {
      timeline.push({ at: e.occurredAt, kind: "on_hold", title: "Delivery on hold", detail: e.message, tone: "warn" });
    } else if (e.kind === "status" && e.status?.startsWith("cancelled") && !cons.find((c) => c.id === e.consignmentRowId)?.returnedAt) {
      timeline.push({ at: e.occurredAt, kind: "courier_cancelled", title: "Delivery cancelled", detail: e.message, tone: "bad" });
    }
  }
  if (order.cancelledAt) timeline.push({ at: order.cancelledAt, kind: "cancelled", title: "Order cancelled", tone: "bad" });

  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const active = cons.find((c) => c.id === order.activeConsignmentId) ?? cons.filter((c) => !c.superseded).at(-1) ?? null;
  const booked = Boolean(active?.consignmentId || active?.trackingCode);
  const stage = order.courierStage;
  const delivered = stage === "delivered" || stage === "partial_delivered";
  const pickedUp = Boolean(active?.pickedUpAt) || ["in_transit", "on_hold", "returned"].includes(stage) || delivered;

  const steps: TrackingStep[] = [
    { key: "placed", label: "Placed", done: true, at: order.shopCreatedAt },
    { key: "confirmed", label: "Confirmed", done: Boolean(order.confirmedAt) || booked, at: order.confirmedAt },
    { key: "packed", label: "Packed", done: Boolean(order.sortedAt) || pickedUp, at: order.sortedAt },
    { key: "shipped", label: "With courier", done: pickedUp, at: active?.pickedUpAt ?? null },
    { key: "delivered", label: "Delivered", done: delivered, at: active?.deliveredAt ?? null },
  ];

  let status: { key: string; title: string; tone: TrackingTone };
  if (order.cancelledAt || order.callingStatus === "rejected") status = { key: "cancelled", title: "Order cancelled", tone: "bad" };
  else if (stage === "returned") status = { key: "returned", title: "Parcel returned", tone: "bad" };
  else if (stage === "cancelled") status = { key: "cancelled", title: "Delivery cancelled", tone: "bad" };
  else if (stage === "delivered") status = { key: "delivered", title: "Delivered", tone: "good" };
  else if (stage === "partial_delivered") status = { key: "delivered", title: "Partially delivered", tone: "good" };
  else if (stage === "on_hold") status = { key: "on_hold", title: "Delivery on hold", tone: "warn" };
  else if (pickedUp) status = { key: "shipped", title: "On the way with Steadfast", tone: "info" };
  else if (order.sortedAt) status = { key: "packed", title: "Packed — waiting for courier pickup", tone: "info" };
  else if (booked) status = { key: "booked", title: "Sent to courier — being packed", tone: "info" };
  else if (order.confirmedAt || order.callingStatus === "confirmed") status = { key: "confirmed", title: "Confirmed — preparing your parcel", tone: "good" };
  else if (order.callingStatus === "no_answer" || order.callingStatus === "call_again")
    status = { key: "awaiting_call", title: "Waiting for confirmation — please pick up our call", tone: "warn" };
  else status = { key: "placed", title: "Order received — we'll call you to confirm", tone: "info" };

  const codDue = active?.codAmount ?? order.outstanding;

  return {
    business: { name: appSettings.businessName, phone: appSettings.businessPhone || null },
    order: {
      name: order.name,
      placedAt: order.shopCreatedAt,
      currency: order.currency,
      items: order.lineItems.map((li) => ({ title: li.title, variant: li.variantTitle ?? null, quantity: li.quantity, price: li.price })),
      subtotal: order.subtotal,
      shipping: order.shippingTotal,
      discount: order.discountTotal,
      total: order.total,
      codDue: delivered ? 0 : codDue,
    },
    customer: {
      name: order.customerName,
      phone: maskPhone(order.phone ?? order.rawPhone),
      address: [order.address1, order.address2].filter(Boolean).join(", ") || null,
      city: order.city,
    },
    courier: active && booked ? { name: "Steadfast Courier", trackingCode: active.trackingCode, consignmentId: active.consignmentId } : null,
    status,
    steps,
    timeline: timeline.reverse(),
    updatedAt: order.updatedAt,
  };
}
