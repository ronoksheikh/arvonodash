import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db";
import { inList } from "../db";
import { consignments, orders, pickups } from "../db/schema";
import { HttpError, nowIso } from "../lib/util";
import { addEvents, businessDate, dayRange, offsetMinutes, type Actor } from "./dispatch";
import type { AppSettings } from "./settings";

/**
 * Same-day dispatch: orders confirmed before the daily cut-off ship today. The pickup page shows
 * where each of them is (booking → label → scan → handed to rider → picked up by Steadfast), and
 * the handover checklist records which scanned parcels the rider took, so nothing is left behind.
 */

export type PlanStage =
  | "needs_booking"
  | "needs_label"
  | "needs_scan"
  | "ready"
  | "handed_over"
  | "picked_up"
  | "pull_out" // scanned, then cancelled in Shopify: take it off the pile
  | "next_day"; // confirmed after the cut-off

/** Local wall-clock time on a business date → UTC ISO. */
export function localTimeIso(date: string, hhmm: string, offset: string): string {
  return new Date(Date.parse(`${date}T${hhmm}:00Z`) - offsetMinutes(offset) * 60_000).toISOString();
}

export async function dayPlan(db: DB, settings: AppSettings, offset: string, now = new Date()) {
  const today = businessDate(now, offset);
  const { from: dayStart } = dayRange(today, offset);
  const cutoffAt = localTimeIso(today, settings.cutoffTime, offset);
  const pickupAt = localTimeIso(today, settings.pickupTime, offset);

  const rows = await db
    .select({
      id: orders.id,
      name: orders.name,
      customerName: orders.customerName,
      phone: orders.phone,
      city: orders.city,
      total: orders.total,
      confirmedAt: orders.confirmedAt,
      courierStage: orders.courierStage,
      labelStatus: orders.labelStatus,
      dispatchStatus: orders.dispatchStatus,
      sortedAt: orders.sortedAt,
      handedOverAt: orders.handedOverAt,
      pickupId: orders.pickupId,
      dispatchedAt: orders.dispatchedAt,
      autoBookAt: orders.autoBookAt,
      autoBookNote: orders.autoBookNote,
      cancelledAt: orders.cancelledAt,
      consignmentId: consignments.consignmentId,
      trackingCode: consignments.trackingCode,
      codAmount: consignments.codAmount,
    })
    .from(orders)
    .leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId))
    .where(
      sql`${orders.archived} = 0 and (
        (${orders.cancelledAt} is null and ${orders.callingStatus} = 'confirmed' and ${orders.courierStage} in ('unbooked', 'booked')
          and coalesce(${orders.shopifyFulfillmentStatus}, '') not in ('fulfilled', 'partially_fulfilled', 'partial'))
        or (${orders.dispatchStatus} = 'sorted' and ${orders.handedOverAt} is null)
        or ${orders.handedOverAt} >= ${dayStart}
        or (${orders.dispatchStatus} = 'dispatched' and ${orders.dispatchedAt} >= ${dayStart})
      )`,
    )
    .orderBy(orders.confirmedAt)
    .limit(3000)
    .all();

  const parcels = rows.map((r) => {
    let stage: PlanStage;
    if (r.dispatchStatus === "dispatched") stage = "picked_up";
    else if (r.handedOverAt) stage = "handed_over";
    else if (r.cancelledAt) stage = "pull_out";
    else if (r.dispatchStatus === "sorted") stage = "ready";
    else if (r.confirmedAt && r.confirmedAt >= cutoffAt) stage = "next_day";
    else if (r.courierStage === "unbooked") stage = "needs_booking";
    else if (r.labelStatus !== "printed") stage = "needs_label";
    else stage = "needs_scan";
    const carriedOver = Boolean(r.confirmedAt && r.confirmedAt < dayStart) && ["needs_booking", "needs_label", "needs_scan", "ready"].includes(stage);
    return { ...r, codAmount: r.codAmount ?? r.total, stage, carriedOver };
  });

  const count = (s: PlanStage) => parcels.filter((p) => p.stage === s).length;
  const notReady = count("needs_booking") + count("needs_label") + count("needs_scan");
  const counts = {
    needsBooking: count("needs_booking"),
    needsLabel: count("needs_label"),
    needsScan: count("needs_scan"),
    ready: count("ready"),
    handedOver: count("handed_over"),
    pickedUp: count("picked_up"),
    pullOut: count("pull_out"),
    nextDay: count("next_day"),
    carriedOver: parcels.filter((p) => p.carriedOver).length,
    notReady,
    shipToday: notReady + count("ready") + count("handed_over") + count("picked_up"),
  };

  const todaysPickups = await db.select().from(pickups).where(eq(pickups.businessDate, today)).orderBy(desc(pickups.createdAt)).all();
  const confirmed = todaysPickups.length
    ? await db
        .select({ pickupId: orders.pickupId, n: sql<number>`count(*)` })
        .from(orders)
        .where(and(inArray(orders.pickupId, todaysPickups.map((p) => p.id)), eq(orders.dispatchStatus, "dispatched")))
        .groupBy(orders.pickupId)
        .all()
    : [];

  return {
    date: today,
    now: now.toISOString(),
    cutoffTime: settings.cutoffTime,
    cutoffAt,
    pickupTime: settings.pickupTime,
    pickupAt,
    counts,
    parcels,
    pickups: todaysPickups.map((p) => ({ ...p, confirmedBySteadfast: Number(confirmed.find((c) => c.pickupId === p.id)?.n ?? 0) })),
  };
}

/**
 * Courier arrived: record which scanned parcels went with the rider. Only parcels that are scanned,
 * not cancelled and not yet handed over can be handed over (one conditional UPDATE, so twice-clicking
 * or two devices can't hand the same parcel over twice).
 */
export async function confirmHandover(
  db: DB,
  actor: Actor,
  settings: AppSettings,
  offset: string,
  input: { orderIds: number[]; riderName?: string | null; riderPhone?: string | null; note?: string | null },
) {
  if (!input.orderIds.length) throw new HttpError(400, "Select the parcels the rider is taking");
  const plan = await dayPlan(db, settings, offset);
  const id = crypto.randomUUID();
  const now = nowIso();
  const handed = await db
    .update(orders)
    .set({ pickupId: id, handedOverAt: now })
    .where(
      and(
        inList(orders.id, input.orderIds),
        sql`${orders.dispatchStatus} = 'sorted' and ${orders.handedOverAt} is null and ${orders.cancelledAt} is null and ${orders.courierStage} = 'booked'`,
      ),
    )
    .returning({ id: orders.id, consignmentRowId: orders.activeConsignmentId })
    .all();
  if (!handed.length) throw new HttpError(409, "None of these parcels can be handed over (already handed over, cancelled or not scanned)");
  const riderName = input.riderName?.trim() || null;
  const riderPhone = input.riderPhone?.replace(/[^\d+]/g, "") || null;
  await db.insert(pickups).values({
    id,
    businessDate: plan.date,
    riderName,
    riderPhone,
    readyCount: plan.counts.ready,
    handedCount: handed.length,
    leftBehindCount: plan.counts.notReady,
    note: input.note?.trim() || null,
    handedBy: actor.name,
    createdAt: now,
  });
  const who = [riderName, riderPhone].filter(Boolean).join(" · ") || "courier rider";
  await addEvents(db, handed.map((h) => ({ orderId: h.id, event: "handed_over", consignmentRowId: h.consignmentRowId, note: who })), actor);
  return {
    pickupId: id,
    handed: handed.length,
    skipped: input.orderIds.filter((x) => !handed.some((h) => h.id === x)),
    leftBehind: plan.counts.notReady,
  };
}
