import { asc, eq, or } from "drizzle-orm";
import type { DB } from "../db";
import { activityLog, callLogs, consignments, dispatchEvents, orderNotes, orders, returns, smsMessages, trackingEvents } from "../db/schema";
import { CARRYBEE_STATUSES, COURIERS, type CourierId } from "../../shared/couriers";
import { DISPATCH_EVENTS, NOTE_KINDS, SMS_TRIGGER_LABELS, STEADFAST_STATUSES, type SmsTrigger } from "../../shared/constants";

/**
 * Everything that ever happened to an order and its parcel, from every source we record
 * (Shopify, calls, booking, printing, packing scans, handover, Steadfast, SMS, staff actions),
 * merged into one timeline, plus the time of each milestone for "how long did each step take".
 */

export type JourneySource = "shopify" | "call" | "booking" | "warehouse" | "courier" | "sms" | "staff" | "system";
export type JourneyEntry = { at: string; source: JourneySource; title: string; detail: string | null; actor: string | null; tone?: "good" | "warn" | "bad" };

export type Milestones = {
  placed: string;
  confirmed: string | null;
  booked: string | null;
  printed: string | null;
  packed: string | null;
  handedOver: string | null;
  pickedUp: string | null;
  outcome: string | null; // delivered / partial / returned
  outcomeKind: "delivered" | "partial_delivered" | "returned" | null;
  paid: string | null;
};

// Logged elsewhere in the journey already (call logs, courier status events).
const SKIP_ACTIVITY = /^(calling\.|courier\.status$|sms\.)/;

const ACTIVITY_TITLES: Record<string, string> = {
  "order.cancelled_in_shopify": "Cancelled in Shopify",
  "order.cancelled_after_booking": "Cancelled in Shopify after booking",
  "order.deleted_in_shopify": "Deleted in Shopify",
  "consignment.created": "Booked with Steadfast",
  "consignment.deleted_in_steadfast": "Parcel deleted in Steadfast",
  "return.created": "Return opened",
  "fulfillment.created": "Fulfilled in Shopify",
  "shopify.marked_paid": "Marked paid in Shopify",
};

const titleize = (action: string) => ACTIVITY_TITLES[action] ?? action.replace(/[._]/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());

export async function buildJourney(db: DB, order: typeof orders.$inferSelect) {
  const parcelFilter = order.activeConsignmentId ? eq(consignments.id, order.activeConsignmentId) : undefined;
  const [cons, calls, dispatch, tracking, notes, activity, rets, sms] = await Promise.all([
    db.select().from(consignments).where(or(eq(consignments.orderId, order.id), parcelFilter)).orderBy(asc(consignments.createdAt)).all(),
    db.select().from(callLogs).where(eq(callLogs.orderId, order.id)).all(),
    db.select().from(dispatchEvents).where(eq(dispatchEvents.orderId, order.id)).all(),
    db.select().from(trackingEvents).where(or(eq(trackingEvents.orderId, order.id), order.activeConsignmentId ? eq(trackingEvents.consignmentRowId, order.activeConsignmentId) : undefined)).all(),
    db.select().from(orderNotes).where(eq(orderNotes.orderId, order.id)).all(),
    db.select().from(activityLog).where(eq(activityLog.orderId, order.id)).all(),
    db.select().from(returns).where(eq(returns.orderId, order.id)).all(),
    db.select().from(smsMessages).where(eq(smsMessages.orderId, order.id)).all(),
  ]);

  const out: JourneyEntry[] = [];
  const push = (e: JourneyEntry) => e.at && out.push(e);

  push({ at: order.shopCreatedAt, source: "shopify", title: "Order placed in Shopify", detail: `${order.name} · ${order.lineItems.reduce((n, li) => n + li.quantity, 0)} item(s)`, actor: order.sourceName });
  push({ at: order.createdAt, source: "system", title: "Received by the dashboard", detail: null, actor: null });
  if (order.cancelledAt) push({ at: order.cancelledAt, source: "shopify", title: "Cancelled in Shopify", detail: order.cancelReason, actor: null, tone: "bad" });
  if (order.shopifyDeletedAt) push({ at: order.shopifyDeletedAt, source: "shopify", title: "Deleted in Shopify", detail: "The order no longer exists in Shopify", actor: null, tone: "bad" });
  if (order.fulfilledAt) push({ at: order.fulfilledAt, source: "shopify", title: "Fulfilled in Shopify", detail: null, actor: null });
  if (order.shopifyPaidAt) push({ at: order.shopifyPaidAt, source: "shopify", title: "Marked paid in Shopify", detail: null, actor: null, tone: "good" });

  for (const c of calls) {
    push({ at: c.createdAt, source: "call", title: `Call: ${c.outcome.replace(/_/g, " ")}`, detail: c.note, actor: c.userName, tone: c.outcome === "confirmed" ? "good" : c.outcome === "rejected" ? "bad" : undefined });
  }
  for (const c of cons) {
    if (c.consignmentId || c.trackingCode) {
      push({ at: c.createdAt, source: "booking", title: c.orderId === order.id ? "Booked with Steadfast" : "Added to a combined parcel", detail: [c.consignmentId && `CID ${c.consignmentId}`, c.trackingCode, `invoice ${c.invoice}`, `COD ৳${c.codAmount}`].filter(Boolean).join(" · "), actor: null });
    }
    if (c.superseded) push({ at: c.updatedAt, source: "booking", title: "Consignment replaced by a rebooking", detail: c.invoice, actor: null, tone: "warn" });
    if (c.settledAt) push({ at: c.settledAt, source: "courier", title: `COD paid out by ${COURIERS[c.courier as CourierId]?.label ?? "the courier"}`, detail: c.paymentId ? `Payment ${c.paymentId}` : null, actor: null, tone: "good" });
  }
  for (const d of dispatch) {
    push({ at: d.createdAt, source: "warehouse", title: DISPATCH_EVENTS[d.event] ?? d.event, detail: d.note, actor: d.actor, tone: d.event === "carried_over" || d.event === "picked_up_unscanned" ? "warn" : undefined });
  }
  for (const t of tracking) {
    const courier = cons.find((c) => c.id === t.consignmentRowId)?.courier ?? "steadfast";
    const label = courier === "carrybee" ? CARRYBEE_STATUSES[t.status ?? ""] : STEADFAST_STATUSES[t.status ?? ""];
    const title = t.kind === "status" ? `${COURIERS[courier as CourierId]?.label ?? courier}: ${label ?? t.status}` : (t.message ?? "Courier update");
    push({ at: t.occurredAt, source: "courier", title, detail: t.kind === "status" ? t.message : null, actor: t.source, tone: t.status === "delivered" ? "good" : t.status === "cancelled" || t.status === "deleted" ? "bad" : undefined });
  }
  for (const r of rets) {
    push({ at: r.createdAt, source: "courier", title: "Return opened", detail: r.reason, actor: null, tone: "warn" });
    if (r.receivedAt) push({ at: r.receivedAt, source: "warehouse", title: "Return received back", detail: r.condition, actor: null });
  }
  for (const m of sms) {
    const label = SMS_TRIGGER_LABELS[m.trigger as SmsTrigger]?.label ?? (m.trigger === "manual" ? "Manual message" : m.trigger);
    push({ at: m.createdAt, source: "sms", title: `SMS ${m.status === "sent" ? "sent" : m.status}: ${label}`, detail: m.status === "sent" ? m.body : `${m.providerMessage ?? ""} — ${m.body}`, actor: m.sentBy, tone: m.status === "failed" ? "bad" : undefined });
  }
  for (const n of notes) {
    if (n.kind === "call_log") continue;
    push({ at: n.createdAt, source: "staff", title: NOTE_KINDS[n.kind as keyof typeof NOTE_KINDS] ?? "Note", detail: n.body, actor: null });
  }
  for (const a of activity) {
    if (SKIP_ACTIVITY.test(a.action)) continue;
    push({ at: a.createdAt, source: a.actor === "shopify" ? "shopify" : a.actor === "steadfast" ? "courier" : a.userId ? "staff" : "system", title: titleize(a.action), detail: a.details ? JSON.stringify(a.details) : null, actor: a.actor });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const parcel = cons.find((c) => c.id === order.activeConsignmentId) ?? null;
  const firstEvent = (name: string) => dispatch.filter((d) => d.event === name).map((d) => d.createdAt).sort()[0] ?? null;
  const outcomeKind = parcel?.stage === "delivered" || parcel?.stage === "partial_delivered" ? parcel.stage : parcel?.stage === "returned" ? "returned" : null;
  const milestones: Milestones = {
    placed: order.shopCreatedAt,
    confirmed: order.confirmedAt,
    booked: order.bookedAt ?? parcel?.createdAt ?? null,
    printed: order.printedAt ?? firstEvent("printed"),
    packed: firstEvent("sorted") ?? order.sortedAt,
    handedOver: order.handedOverAt, // cleared again if the handover was undone
    pickedUp: parcel?.pickedUpAt ?? order.dispatchedAt,
    outcome: outcomeKind === "returned" ? (parcel?.returnedAt ?? null) : outcomeKind ? (parcel?.deliveredAt ?? null) : null,
    outcomeKind,
    paid: parcel?.settledAt ?? null,
  };
  return { entries: out, milestones };
}
