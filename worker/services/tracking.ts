import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { DB } from "../db";
import { callLogs, consignments, orders, trackingEvents } from "../db/schema";
import { getSettings, getValue, setValue, type AppSettings } from "./settings";
import { partialOutcome } from "../../shared/delivery";

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

// ---------------------------------------------------------------------------
// Custom tracking domain (e.g. track.arvono.store → this Worker)

let hostCache: { at: number; value: { host: string; storeUrl: string } | null } | null = null;

/** Host of the tracking domain from Settings → Tracking page. Read on every request, so cached per isolate. */
export async function trackingHost(env: { DB: D1Database }) {
  if (hostCache && Date.now() - hostCache.at < 60_000) return hostCache.value;
  let value: { host: string; storeUrl: string } | null = null;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'app'").first<{ value: string }>();
    const s = row?.value ? (JSON.parse(row.value) as Partial<AppSettings>) : {};
    if (s.trackingBaseUrl) value = { host: new URL(s.trackingBaseUrl).hostname, storeUrl: s.storeUrl || "https://arvono.store" };
  } catch {
    value = null; // fresh install (no settings table yet) or a bad value: behave like the dashboard
  }
  hostCache = { at: Date.now(), value };
  return value;
}

/** Called when the setting is saved, so this isolate switches over at once. */
export function forgetTrackingHost() {
  hostCache = null;
}

const ORIGIN_KEY = "app.origin";
const INSTANCE_KEY = "app.instanceId";

/** Random id of this installation; the tracking-domain check compares it to prove the domain reaches us. */
export async function instanceId(db: DB): Promise<string> {
  const existing = await getValue<string>(db, INSTANCE_KEY);
  if (existing) return existing;
  const id = newTrackingToken();
  await setValue(db, INSTANCE_KEY, id);
  return id;
}

/**
 * Where customer links point: the custom tracking domain (Settings → Tracking page) when set,
 * otherwise the dashboard's own address (remembered from the last sign-in, for background jobs).
 */
export async function trackingBase(db: DB, appSettings: AppSettings, requestOrigin?: string | null): Promise<string> {
  return appSettings.trackingBaseUrl || requestOrigin || (await getValue<string>(db, ORIGIN_KEY)) || "";
}

export async function publicTrackingUrl(db: DB, appSettings: AppSettings, token: string, requestOrigin?: string | null) {
  return trackingPageUrl(await trackingBase(db, appSettings, requestOrigin), token);
}

/** Remembers the dashboard's address so jobs without a request can still build links. */
export async function rememberOrigin(db: DB, origin: string) {
  if (!/^https?:\/\//.test(origin) || (await getValue<string>(db, ORIGIN_KEY)) === origin) return;
  await setValue(db, ORIGIN_KEY, origin);
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
    // An order combined into another order's booking shares that parcel.
    db
      .select()
      .from(consignments)
      .where(or(eq(consignments.orderId, order.id), order.activeConsignmentId ? eq(consignments.id, order.activeConsignmentId) : undefined))
      .orderBy(asc(consignments.createdAt))
      .all(),
    db
      .select()
      .from(trackingEvents)
      .where(or(eq(trackingEvents.orderId, order.id), order.activeConsignmentId ? eq(trackingEvents.consignmentRowId, order.activeConsignmentId) : undefined))
      .orderBy(asc(trackingEvents.occurredAt), asc(trackingEvents.id))
      .all(),
    getSettings(db),
  ]);

  const timeline: TrackingEvent[] = [{ at: order.shopCreatedAt, kind: "placed", title: "Order placed", detail: `Order ${order.name}`, tone: "info" }];

  for (const [i, call] of calls.entries()) {
    const e = CALL_EVENTS[call.outcome];
    // The same outcome logged twice in a row (two calls, or a re-click) is one update for the customer.
    if (!e || calls[i - 1]?.outcome === call.outcome) continue;
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
    // The rider's report reaches the customer first; Steadfast's later confirmation adds nothing new for them.
    const riderReport = events.find((e) => e.consignmentRowId === c.id && e.kind === "status" && e.status?.endsWith("_approval_pending"));
    const outcomeAt = c.deliveredAt ?? (riderReport?.status?.startsWith("delivered") || riderReport?.status?.startsWith("partial") ? riderReport.occurredAt : null);
    if (outcomeAt) {
      const partial = c.stage === "partial_delivered" || riderReport?.status?.startsWith("partial");
      const chargeOnly = partial && c.stage === "partial_delivered" && partialOutcome(c.collectedAmount, order.lineItems) === "charge_only";
      timeline.push({
        at: riderReport?.occurredAt && riderReport.occurredAt < outcomeAt ? riderReport.occurredAt : outcomeAt,
        kind: chargeOnly ? "returned" : "delivered",
        title: chargeOnly ? "Product returned — delivery charge paid" : partial ? "Partially delivered" : "Delivered",
        tone: chargeOnly ? "warn" : "good",
      });
    }
    if (c.returnedAt) {
      // After a partial delivery only the refused items come back; that's not a failed delivery.
      const partialReturn = c.stage === "partial_delivered";
      timeline.push({ at: c.returnedAt, kind: "returned", title: partialReturn ? "Returned items received back by us" : "Delivery failed — parcel returned", tone: partialReturn ? "info" : "bad" });
    }
  }
  if (order.sortedAt) timeline.push({ at: order.sortedAt, kind: "packed", title: "Packed and ready for courier pickup", tone: "info" });

  for (const e of events) {
    // Steadfast's own "created" step repeats our "Sent to Steadfast" entry.
    if (e.kind === "tracking" && e.message && !/^consignment created/i.test(e.message)) {
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
  const riderSays = active?.stage === "awaiting_confirmation" ? active.status : null; // e.g. delivered_approval_pending
  const booked = Boolean(active?.consignmentId || active?.trackingCode);
  const stage = order.courierStage;
  const delivered = stage === "delivered" || stage === "partial_delivered" || Boolean(riderSays?.startsWith("delivered") || riderSays?.startsWith("partial"));
  const pickedUp = Boolean(active?.pickedUpAt) || ["in_transit", "on_hold", "awaiting_confirmation", "returned"].includes(stage) || delivered;

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
  else if (stage === "delivered" || riderSays?.startsWith("delivered")) status = { key: "delivered", title: "Delivered", tone: "good" };
  else if (stage === "partial_delivered" && active && partialOutcome(active.collectedAmount, order.lineItems) === "charge_only")
    status = { key: "returned", title: "Product returned — delivery charge paid", tone: "warn" };
  else if (stage === "partial_delivered" || riderSays?.startsWith("partial")) status = { key: "delivered", title: "Partially delivered", tone: "good" };
  else if (riderSays?.startsWith("cancelled")) status = { key: "cancelled", title: "Delivery cancelled", tone: "bad" };
  else if (stage === "on_hold") status = { key: "on_hold", title: "Delivery on hold", tone: "warn" };
  else if (pickedUp) status = { key: "shipped", title: "On the way with Steadfast", tone: "info" };
  else if (order.sortedAt) status = { key: "packed", title: "Packed — waiting for courier pickup", tone: "info" };
  else if (booked) status = { key: "booked", title: "Sent to courier — being packed", tone: "info" };
  else if (order.confirmedAt || order.callingStatus === "confirmed") status = { key: "confirmed", title: "Confirmed — preparing your parcel", tone: "good" };
  else if (order.callingStatus === "no_answer" || order.callingStatus === "call_again")
    status = { key: "awaiting_call", title: "Waiting for confirmation — please pick up our call", tone: "warn" };
  else status = { key: "placed", title: "Order received — we'll call you to confirm", tone: "info" };

  // A combined parcel collects for every order in it, so the customer pays the parcel's COD once.
  const together = active
    ? (await db.select({ id: orders.id, name: orders.name }).from(orders).where(eq(orders.activeConsignmentId, active.id)).all()).filter((o) => o.id !== order.id).map((o) => o.name)
    : [];
  const codDue = active?.codAmount ?? order.outstanding;

  return {
    business: { name: appSettings.businessName, phone: appSettings.businessPhone || null, website: appSettings.storeUrl || null },
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
      shipsWith: together,
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
