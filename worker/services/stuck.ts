import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db";
import { inList } from "../db";
import { consignments, orderNotes, orders, pickups, trackingEvents } from "../db/schema";
import { HttpError, nowIso } from "../lib/util";
import { logActivity } from "./activity";
import type { SessionUser } from "../env";
import type { AppSettings } from "./settings";

/**
 * Parcels that need a phone call: handed to the rider but never confirmed by Steadfast, scanned but
 * never collected, on hold, silent for days, or slower than normal for their district.
 * "Normal" is learned from our own delivered parcels per district; too little history → defaults.
 */

export type StuckReason = "exceptional" | "not_received" | "waiting_pickup" | "on_hold" | "unconfirmed" | "no_update" | "slow_transit";
const DAY = 86_400_000;
const PHONE_RE = /(?:\+?88)?01[3-9]\d{8}/g;

const cityKey = (city: string | null | undefined) => (city ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Typical door-to-door days per district (80th percentile of our own deliveries, last 120 days). */
export async function transitNorms(db: DB) {
  const since = new Date(Date.now() - 120 * DAY).toISOString();
  const rows = await db
    .select({ city: orders.city, pickedUpAt: consignments.pickedUpAt, deliveredAt: consignments.deliveredAt })
    .from(consignments)
    .innerJoin(orders, eq(orders.id, consignments.orderId))
    .where(sql`${consignments.deliveredAt} >= ${since} and ${consignments.pickedUpAt} is not null`)
    .limit(20_000)
    .all();
  const byCity = new Map<string, number[]>();
  for (const r of rows) {
    const days = (Date.parse(r.deliveredAt!) - Date.parse(r.pickedUpAt!)) / DAY;
    if (!(days >= 0)) continue;
    const k = cityKey(r.city);
    byCity.set(k, [...(byCity.get(k) ?? []), days]);
  }
  const norms = new Map<string, { days: number; samples: number }>();
  for (const [k, list] of byCity) {
    if (list.length < 5) continue;
    list.sort((a, b) => a - b);
    norms.set(k, { days: Math.max(1, Math.ceil(list[Math.floor(list.length * 0.8)])), samples: list.length });
  }
  return norms;
}

export function expectedDays(city: string | null, norms: Map<string, { days: number; samples: number }>, settings: AppSettings) {
  const learned = norms.get(cityKey(city));
  if (learned) return { days: learned.days, basis: `${learned.samples} past deliveries` };
  const dhaka = cityKey(city).includes("dhaka");
  return { days: dhaka ? settings.transitDaysDhaka : settings.transitDaysOutside, basis: dhaka ? "default for Dhaka" : "default outside Dhaka" };
}

export async function stuckParcels(db: DB, settings: AppSettings, opts: { includeSnoozed?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const nowIsoStr = now.toISOString();
  const rows = await db
    .select({
      rowId: consignments.id,
      orderId: orders.id,
      orderName: orders.name,
      customerName: consignments.recipientName,
      phone: consignments.recipientPhone,
      city: orders.city,
      address: consignments.recipientAddress,
      codAmount: consignments.codAmount,
      consignmentId: consignments.consignmentId,
      trackingCode: consignments.trackingCode,
      status: consignments.status,
      stage: consignments.stage,
      lastMessage: consignments.lastMessage,
      lastStatusAt: consignments.lastStatusAt,
      pickedUpAt: consignments.pickedUpAt,
      bookedAt: consignments.createdAt,
      followUpNote: consignments.followUpNote,
      followUpAt: consignments.followUpAt,
      followUpBy: consignments.followUpBy,
      snoozedUntil: consignments.snoozedUntil,
      sortedAt: orders.sortedAt,
      handedOverAt: orders.handedOverAt,
      dispatchStatus: orders.dispatchStatus,
      cancelledAt: orders.cancelledAt,
      pickupRiderName: pickups.riderName,
      pickupRiderPhone: pickups.riderPhone,
    })
    .from(consignments)
    .innerJoin(orders, and(eq(orders.id, consignments.orderId), eq(orders.activeConsignmentId, consignments.id)))
    .leftJoin(pickups, eq(pickups.id, orders.pickupId))
    .where(sql`${consignments.isFinal} = 0 and ${consignments.superseded} = 0 and ${consignments.consignmentId} is not null and ${orders.archived} = 0`)
    .limit(5000)
    .all();
  if (!rows.length) return { parcels: [], snoozed: 0 };

  const norms = await transitNorms(db);
  // Latest courier activity (status or tracking message) per consignment.
  const activity = await db
    .select({ rowId: trackingEvents.consignmentRowId, last: sql<string>`max(${trackingEvents.occurredAt})` })
    .from(trackingEvents)
    .where(and(inArray(trackingEvents.consignmentRowId, db.select({ id: consignments.id }).from(consignments).where(eq(consignments.isFinal, false))), sql`${trackingEvents.source} != 'api'`))
    .groupBy(trackingEvents.consignmentRowId)
    .all();
  const lastActivity = new Map(activity.map((a) => [a.rowId, a.last]));

  const handoverMs = settings.handoverConfirmHours * 3_600_000;
  const out = [];
  let snoozed = 0;
  for (const r of rows) {
    const reasons: { code: StuckReason; text: string }[] = [];
    const lastUpdate = [lastActivity.get(r.rowId), r.lastStatusAt, r.pickedUpAt].filter(Boolean).sort().at(-1) ?? null;
    const exp = expectedDays(r.city, norms, settings);
    const transitDays = r.pickedUpAt ? (now.getTime() - Date.parse(r.pickedUpAt)) / DAY : null;
    const silentDays = lastUpdate ? (now.getTime() - Date.parse(lastUpdate)) / DAY : null;

    if (!r.pickedUpAt && r.status === "in_review") {
      if (r.handedOverAt && now.getTime() - Date.parse(r.handedOverAt) > handoverMs) {
        reasons.push({ code: "not_received", text: `Handed to the rider ${Math.floor((now.getTime() - Date.parse(r.handedOverAt)) / 3_600_000)}h ago, but Steadfast still shows "in review"` });
      } else if (!r.handedOverAt && r.dispatchStatus === "sorted" && r.sortedAt && now.getTime() - Date.parse(r.sortedAt) > DAY) {
        reasons.push({ code: "waiting_pickup", text: "Scanned and ready more than a day ago, but not collected" });
      }
    }
    if (r.status === "exceptional") reasons.push({ code: "exceptional", text: "Steadfast marked it exceptional (lost or damaged). Contact Steadfast support to claim the COD." });
    if (r.stage === "on_hold") reasons.push({ code: "on_hold", text: `On hold${r.lastMessage ? `: ${r.lastMessage}` : ""}` });
    if (r.stage === "awaiting_confirmation" && r.lastStatusAt && now.getTime() - Date.parse(r.lastStatusAt) > 2 * DAY) {
      const what = r.status.replace("_approval_pending", "").replace(/_/g, " ");
      reasons.push({ code: "unconfirmed", text: `Rider marked it ${what} ${Math.floor((now.getTime() - Date.parse(r.lastStatusAt)) / DAY)} days ago; Steadfast hasn't confirmed yet` });
    }
    if (r.pickedUpAt && silentDays !== null && silentDays >= settings.stuckNoUpdateDays) {
      reasons.push({ code: "no_update", text: `No update from Steadfast for ${Math.floor(silentDays)} days` });
    }
    if (transitDays !== null && transitDays > exp.days && r.stage === "in_transit") {
      reasons.push({ code: "slow_transit", text: `${Math.floor(transitDays)} days with the courier; ${r.city ?? "this area"} usually takes ${exp.days} (${exp.basis})` });
    }
    if (!reasons.length) continue;
    if (!opts.includeSnoozed && r.snoozedUntil && r.snoozedUntil > nowIsoStr) {
      snoozed++;
      continue;
    }
    out.push({
      ...r,
      reasons,
      lastUpdate,
      transitDays: transitDays === null ? null : Math.floor(transitDays),
      expectedDays: exp.days,
      expectedBasis: exp.basis,
      snoozed: Boolean(r.snoozedUntil && r.snoozedUntil > nowIsoStr),
    });
  }

  // Rider numbers Steadfast puts in its tracking messages (e.g. "Assigned to rider … 01XXXXXXXXX").
  const ids = out.map((p) => p.rowId);
  const messages = ids.length
    ? await db
        .select({ rowId: trackingEvents.consignmentRowId, message: trackingEvents.message, at: trackingEvents.occurredAt })
        .from(trackingEvents)
        .where(and(inList(trackingEvents.consignmentRowId, ids), sql`${trackingEvents.message} is not null`))
        .orderBy(desc(trackingEvents.occurredAt))
        .limit(10_000)
        .all()
    : [];
  const severity: Record<StuckReason, number> = { exceptional: 0, not_received: 1, on_hold: 2, unconfirmed: 3, no_update: 4, slow_transit: 5, waiting_pickup: 6 };
  const parcels = out
    .map((p) => {
      const customer = (p.phone ?? "").replace(/\D/g, "").slice(-11);
      const riderPhones: string[] = [];
      for (const m of messages) {
        if (m.rowId !== p.rowId || !m.message) continue;
        for (const hit of m.message.match(PHONE_RE) ?? []) {
          const n = hit.slice(-11);
          if (n !== customer && !riderPhones.includes(n)) riderPhones.push(n);
        }
      }
      return { ...p, riderPhones: riderPhones.slice(0, 3) };
    })
    .sort((a, b) => Math.min(...a.reasons.map((r) => severity[r.code])) - Math.min(...b.reasons.map((r) => severity[r.code])) || (a.lastUpdate ?? "").localeCompare(b.lastUpdate ?? ""));
  return { parcels, snoozed };
}

/** Record a call about a stuck parcel and optionally hide it for a few days. */
export async function recordFollowUp(db: DB, actor: SessionUser, rowId: number, input: { note: string; snoozeDays?: number }) {
  const note = input.note?.trim();
  if (!note) throw new HttpError(400, "Write what happened on the call");
  const c = await db.select({ id: consignments.id, orderId: consignments.orderId, consignmentId: consignments.consignmentId }).from(consignments).where(eq(consignments.id, rowId)).get();
  if (!c) throw new HttpError(404, "Consignment not found");
  const now = nowIso();
  const days = Math.min(14, Math.max(0, Number(input.snoozeDays) || 0));
  await db
    .update(consignments)
    .set({ followUpNote: note, followUpAt: now, followUpBy: actor.name, snoozedUntil: days ? new Date(Date.now() + days * DAY).toISOString() : null })
    .where(eq(consignments.id, rowId));
  await db.insert(orderNotes).values({ orderId: c.orderId, kind: "internal", body: `Stuck parcel follow-up: ${note}`, userId: actor.id, createdAt: now });
  await logActivity(db, actor, "courier.follow_up", { entityType: "consignment", entityId: c.consignmentId ?? String(rowId), orderId: c.orderId, details: { note, snoozeDays: days } });
  return { ok: true, snoozedUntil: days ? new Date(Date.now() + days * DAY).toISOString() : null };
}
