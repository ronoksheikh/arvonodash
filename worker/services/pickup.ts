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
  | "not_collected" // handed over on an earlier day, Steadfast still hasn't confirmed pickup
  | "picked_up"
  | "pull_out" // scanned, then cancelled in Shopify: take it off the pile
  | "next_day"; // confirmed after the cut-off

/** Local wall-clock time on a business date → UTC ISO. */
export function localTimeIso(date: string, hhmm: string, offset: string): string {
  return new Date(Date.parse(`${date}T${hhmm}:00Z`) - offsetMinutes(offset) * 60_000).toISOString();
}

/** The business date a parcel should leave: today when ready before the cut-off, else the next day. */
export function shipByDate(readyAt: string, cutoffTime: string, offset: string): string {
  const day = businessDate(readyAt, offset);
  if (readyAt < localTimeIso(day, cutoffTime, offset)) return day;
  return businessDate(new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000), "+00:00");
}

/**
 * Daily roll-over (runs with the cron; only the first run after midnight finds anything): parcels
 * still in the warehouse after their pickup day move to today, counted and logged each day they
 * miss, so they head tomorrow's list instead of being forgotten. Handed-over parcels are not
 * carried over: the rider has them (see "not collected" if Steadfast never confirms).
 */
export async function rollOverMissedPickups(db: DB, offset: string, now = new Date()) {
  const today = businessDate(now, offset);
  const rows = await db
    .update(orders)
    .set({ shipBy: today, carryOverCount: sql`${orders.carryOverCount} + 1` })
    .where(
      sql`${orders.shipBy} < ${today} and ${orders.handedOverAt} is null and ${orders.dispatchStatus} != 'dispatched'
        and ${orders.courierStage} = 'booked' and ${orders.cancelledAt} is null and ${orders.archived} = 0 and ${orders.combinedIntoOrderId} is null`,
    )
    .returning({ id: orders.id, consignmentRowId: orders.activeConsignmentId, count: orders.carryOverCount, sorted: orders.dispatchStatus })
    .all();
  await addEvents(
    db,
    rows.map((r) => ({ orderId: r.id, consignmentRowId: r.consignmentRowId, event: "carried_over", note: `${r.sorted === "sorted" ? "Packed" : "Not packed"}; due ${today} (${r.count} day${r.count > 1 ? "s" : ""} late)` })),
    { name: "system" },
  );
  return { processed: rows.length };
}

/** The rider didn't take these after all: back to "ready" so they go with the next pickup. */
export async function undoHandover(db: DB, actor: Actor, orderIds: number[], reason: string) {
  const rows = await db
    .update(orders)
    .set({ pickupId: null, handedOverAt: null })
    .where(and(inList(orders.id, orderIds), sql`${orders.handedOverAt} is not null and ${orders.dispatchStatus} != 'dispatched'`))
    .returning({ id: orders.id, consignmentRowId: orders.activeConsignmentId })
    .all();
  await addEvents(db, rows.map((r) => ({ orderId: r.id, consignmentRowId: r.consignmentRowId, event: "handover_undone", note: reason || null })), actor);
  return { reverted: rows.map((r) => r.id) };
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
      shipBy: orders.shipBy,
      carryOverCount: orders.carryOverCount,
      consignmentId: consignments.consignmentId,
      trackingCode: consignments.trackingCode,
      codAmount: consignments.codAmount,
    })
    .from(orders)
    .leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId))
    .where(
      sql`${orders.archived} = 0 and ${orders.combinedIntoOrderId} is null and (
        (${orders.cancelledAt} is null and ${orders.callingStatus} = 'confirmed' and ${orders.courierStage} in ('unbooked', 'booked')
          and coalesce(${orders.shopifyFulfillmentStatus}, '') not in ('fulfilled', 'partially_fulfilled', 'partial'))
        or (${orders.dispatchStatus} = 'sorted' and ${orders.handedOverAt} is null)
        or ${orders.handedOverAt} >= ${dayStart}
        or (${orders.handedOverAt} is not null and ${orders.dispatchStatus} != 'dispatched' and ${orders.courierStage} = 'booked')
        or (${orders.dispatchStatus} = 'dispatched' and ${orders.dispatchedAt} >= ${dayStart})
      )`,
    )
    .orderBy(orders.confirmedAt)
    .limit(3000)
    .all();

  const parcels = rows.map((r) => {
    let stage: PlanStage;
    if (r.dispatchStatus === "dispatched") stage = "picked_up";
    else if (r.handedOverAt) stage = r.handedOverAt < dayStart ? "not_collected" : "handed_over";
    else if (r.cancelledAt) stage = "pull_out";
    // Packed is packed: if the rider is here, it goes, even when it was only due tomorrow.
    else if (r.dispatchStatus === "sorted") stage = "ready";
    else if (r.shipBy ? r.shipBy > today : Boolean(r.confirmedAt && r.confirmedAt >= cutoffAt)) stage = "next_day";
    else if (r.courierStage === "unbooked") stage = "needs_booking";
    else if (r.labelStatus !== "printed") stage = "needs_label";
    else stage = "needs_scan";
    const waiting = ["needs_booking", "needs_label", "needs_scan", "ready"].includes(stage);
    // Booked parcels count the pickups they actually missed; unbooked ones, confirmed before today.
    const carriedOver = waiting && (r.carryOverCount > 0 || (r.courierStage === "unbooked" && Boolean(r.confirmedAt && r.confirmedAt < dayStart)));
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
    notCollected: count("not_collected"),
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
