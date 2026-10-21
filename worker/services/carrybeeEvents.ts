import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import { consignments, trackingEvents } from "../db/schema";
import { nowIso, toNumber } from "../lib/util";
import { CARRYBEE_STATUSES } from "../../shared/couriers";
import { logActivity } from "./activity";
import { applyCourierUpdate } from "./courier";
import { normalizeStatus } from "./carrybee";
import { parseSteadfastTime } from "./steadfast";
import { refreshRiskFlags } from "./orders";
import { getSettings } from "./settings";

/** Carrybee webhook body: `event` plus the parcel's ids and, per event, amounts, attempt, reason, rider. */
export type CarrybeeWebhook = {
  event?: string;
  store_id?: string;
  consignment_id?: string;
  merchant_order_id?: string;
  timestamptz?: string;
  collectable_amount?: number | string;
  collected_amount?: number | string;
  cod_fee?: number | string;
  delivery_fee?: number | string;
  attempt?: number;
  reason?: string | null;
  remarks?: string | null;
  agent_name?: string | null;
  agent_phone?: string | null;
  invoice_id?: string;
  position?: number;
  causes?: unknown;
};

const has = (v: unknown) => v !== undefined && v !== null && v !== "";

/** A line for the timeline: Carrybee's label plus whatever the event adds. */
function describe(status: string, p: CarrybeeWebhook): string {
  const parts = [CARRYBEE_STATUSES[status] ?? status];
  if (status === "assigned-for-delivery" && (p.agent_name || p.agent_phone)) parts.push(`rider ${[p.agent_name, p.agent_phone].filter(Boolean).join(" ")}`);
  if (p.attempt && p.attempt > 1) parts.push(`attempt ${p.attempt}`);
  for (const x of [p.reason, p.remarks]) if (x && !/may or may not contain/i.test(x)) parts.push(x);
  return parts.join(" · ");
}

export async function processCarrybeeEvent(db: DB, p: CarrybeeWebhook): Promise<string> {
  const status = normalizeStatus(p.event);
  if (!status) return "ignored";
  const ref = p.consignment_id ? await db.select().from(consignments).where(eq(consignments.consignmentId, String(p.consignment_id))).get() : undefined;
  const c = ref ?? (p.merchant_order_id ? await db.select().from(consignments).where(and(eq(consignments.invoice, String(p.merchant_order_id)), eq(consignments.courier, "carrybee"))).get() : undefined);
  if (!c) return "ignored"; // not ours (or a bulk item we never sent)
  const now = nowIso();
  const at = parseSteadfastTime(p.timestamptz) ?? now;

  if (status === "create-failed") return "ignored"; // only for bulk creation, which we don't use

  if (status === "created" || status === "updated") {
    const patch: Partial<typeof consignments.$inferInsert> = { updatedAt: now };
    if (!c.consignmentId && p.consignment_id) Object.assign(patch, { consignmentId: String(p.consignment_id), trackingCode: String(p.consignment_id) });
    if (has(p.delivery_fee) || has(p.cod_fee)) patch.deliveryCharge = toNumber(p.delivery_fee) + toNumber(p.cod_fee);
    // COD changed on Carrybee's side: keep the old amount so the order is flagged (like Steadfast's consignment_update).
    if (has(p.collectable_amount) && toNumber(p.collectable_amount) !== c.codAmount) {
      Object.assign(patch, { codAmount: toNumber(p.collectable_amount), codChangedFrom: c.codChangedFrom ?? c.codAmount });
    }
    await db.update(consignments).set(patch).where(eq(consignments.id, c.id));
    const msg = patch.codAmount !== undefined ? `COD changed at Carrybee: ৳${c.codAmount} → ৳${patch.codAmount}` : status === "created" ? "Created at Carrybee" : "Updated at Carrybee";
    await db.insert(trackingEvents).values({ consignmentRowId: c.id, orderId: c.orderId, kind: "tracking", message: msg, source: "webhook", occurredAt: at, createdAt: now });
    if (patch.codAmount !== undefined) await refreshRiskFlags(db, c.orderId, await getSettings(db));
    return "processed";
  }

  if (status === "paid") {
    // Carrybee paid this parcel's COD to us.
    await db.update(consignments).set({ paymentId: p.invoice_id ? String(p.invoice_id) : c.paymentId ?? "carrybee", settledAt: at, updatedAt: now }).where(eq(consignments.id, c.id));
    await db.insert(trackingEvents).values({ consignmentRowId: c.id, orderId: c.orderId, kind: "tracking", message: `COD paid out by Carrybee${p.invoice_id ? ` (invoice ${p.invoice_id})` : ""}`, source: "webhook", occurredAt: at, createdAt: now });
    await logActivity(db, "carrybee", "cod.settled", { entityType: "consignment", entityId: c.consignmentId ?? c.invoice, orderId: c.orderId, details: { invoice: p.invoice_id } });
    return "processed";
  }

  const collected = has(p.collected_amount) ? toNumber(p.collected_amount) : null;
  await applyCourierUpdate(db, c, { status, message: describe(status, p), codAmount: collected, occurredAt: at, source: "webhook" }, "carrybee");
  return "processed";
}
