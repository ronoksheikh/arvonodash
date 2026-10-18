import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { DB } from "../db";
import type { Env, SessionUser } from "../env";
import { orders } from "../db/schema";
import { getSettings } from "./settings";
import { logActivity } from "./activity";
import { nowIso } from "../lib/util";

/**
 * Auto-booking: a confirmed order is booked with Steadfast after a short grace period
 * (default 10 minutes). During that window staff can cancel the timer or book immediately.
 * Flagged orders wait for a human unless the setting says otherwise.
 */

export const AUTO_BOOK_USER: SessionUser = { id: 0, email: "system@arvono", name: "Auto-booking", role: "owner", permissions: [] };

export async function scheduleAutoBook(db: DB, orderId: number) {
  const s = await getSettings(db);
  if (!s.autoBookEnabled) return null;
  const at = new Date(Date.now() + Math.max(0, s.autoBookDelayMinutes) * 60_000).toISOString();
  const row = await db
    .update(orders)
    .set({ autoBookAt: at, autoBookNote: null })
    .where(and(eq(orders.id, orderId), eq(orders.courierStage, "unbooked"), eq(orders.callingStatus, "confirmed"), sql`${orders.cancelledAt} is null`))
    .returning({ id: orders.id })
    .get();
  return row ? at : null;
}

export async function cancelAutoBook(db: DB, orderId: number, note: string | null) {
  await db.update(orders).set({ autoBookAt: null, autoBookNote: note }).where(and(eq(orders.id, orderId), isNotNull(orders.autoBookAt)));
}

/** Cron (every minute): book orders whose timer has run out. */
export async function runAutoBookings(env: Env, db: DB) {
  const now = nowIso();
  const due = await db.select({ id: orders.id }).from(orders).where(and(isNotNull(orders.autoBookAt), lte(orders.autoBookAt, now))).limit(40).all();
  if (!due.length) return { processed: 0, booked: 0, skipped: 0 };
  const s = await getSettings(db);
  const { bookOrders } = await import("./courier");
  let booked = 0;
  let skipped = 0;
  for (const { id } of due) {
    // Claim: only one cron run can take a given timer.
    const order = await db
      .update(orders)
      .set({ autoBookAt: null })
      .where(and(eq(orders.id, id), isNotNull(orders.autoBookAt), lte(orders.autoBookAt, now)))
      .returning()
      .get();
    if (!order) continue;
    if (order.courierStage !== "unbooked" || order.callingStatus !== "confirmed" || order.cancelledAt) continue;
    const flags = order.riskDismissed ? [] : (order.riskFlags ?? []);
    if (s.autoBookSkipFlagged && flags.length) {
      await db.update(orders).set({ autoBookNote: "Not auto-booked: review the flags, then book manually" }).where(eq(orders.id, id));
      skipped++;
      continue;
    }
    const [r] = await bookOrders(env, db, AUTO_BOOK_USER, [id]);
    if (r?.ok) {
      booked++;
    } else {
      skipped++;
      await db.update(orders).set({ autoBookNote: `Auto-booking failed: ${r?.error ?? "unknown error"}` }).where(eq(orders.id, id));
      await logActivity(db, "system", "courier.auto_book_failed", { entityType: "order", entityId: id, orderId: id, details: { error: r?.error } });
    }
  }
  return { processed: due.length, booked, skipped };
}
