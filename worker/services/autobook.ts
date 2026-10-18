import { and, eq, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { inList, type DB } from "../db";
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

const FRAUD_WAIT_NOTE = "Waiting for the Steadfast fraud check";
/** If Steadfast can't answer the fraud check for this long after confirmation, book anyway. */
const FRAUD_WAIT_LIMIT_MS = 30 * 60_000;
/** Flags that only say "same customer ordered again"; combining the orders answers them. */
const DUPLICATE_FLAGS = new Set(["duplicate_recent", "duplicate_items"]);

type OrderRow = typeof orders.$inferSelect;

/**
 * Cron (every minute): book orders whose timer has run out.
 * - Risky customers (Steadfast fraud check) are held for a call instead of being booked.
 * - A customer's confirmed orders go out as one parcel: an order waits for its siblings' timers.
 */
export async function runAutoBookings(env: Env, db: DB) {
  const now = nowIso();
  const due = await db.select({ id: orders.id }).from(orders).where(and(isNotNull(orders.autoBookAt), lte(orders.autoBookAt, now))).limit(40).all();
  if (!due.length) return { processed: 0, booked: 0, skipped: 0, held: 0 };
  const s = await getSettings(db);
  const { bookOrders } = await import("./courier");
  let booked = 0;
  let skipped = 0;
  let held = 0;
  const note = (ids: number[], text: string) => db.update(orders).set({ autoBookNote: text }).where(inList(orders.id, ids));

  for (const { id } of due) {
    const order = await claim(db, id, now);
    if (!order) continue;
    if (order.courierStage !== "unbooked" || order.callingStatus !== "confirmed" || order.cancelledAt || order.combinedIntoOrderId) continue;

    // Same customer's other confirmed orders that are also waiting to be booked.
    const siblings = s.autoCombine && order.phone ? await openSiblings(db, order) : [];
    const pending = siblings.filter((x) => x.autoBookAt && x.autoBookAt > now);
    if (pending.length) {
      const at = pending.map((x) => x.autoBookAt!).sort().at(-1)!;
      await db.update(orders).set({ autoBookAt: at, autoBookNote: `Waiting to go in one parcel with ${pending.map((x) => x.name).join(", ")}` }).where(eq(orders.id, id));
      continue;
    }
    const group: OrderRow[] = [order];
    for (const x of siblings.filter((x) => x.autoBookAt)) {
      const taken = await claim(db, x.id, now);
      if (taken) group.push(taken);
    }
    const ids = group.map((g) => g.id);

    // Fraud check: hold risky customers for a call. Wait briefly if Steadfast hasn't answered yet.
    if (s.fraudCheckEnabled && s.fraudHoldAutoBook && order.phone) {
      const { ensureFraudCheck } = await import("./fraud");
      const r = await ensureFraudCheck(env, db, order.phone);
      const waitedTooLong = Date.now() - Date.parse(order.confirmedAt ?? now) > FRAUD_WAIT_LIMIT_MS;
      if (!r.row && r.deferred && !waitedTooLong) {
        const retry = new Date(Date.now() + 2 * 60_000).toISOString();
        await db.update(orders).set({ autoBookAt: retry, autoBookNote: FRAUD_WAIT_NOTE }).where(inList(orders.id, ids));
        continue;
      }
    }
    const fresh = await db.select().from(orders).where(inList(orders.id, ids)).all();
    const flags = new Set(fresh.flatMap((o) => (o.riskDismissed ? [] : (o.riskFlags ?? []))));
    if (flags.has("courier_fraud") && s.fraudHoldAutoBook) {
      await note(ids, "Held for a call: Steadfast fraud check shows a poor delivery record or merchant reports. Book manually after calling.");
      await logActivity(db, "system", "courier.auto_book_held", { entityType: "order", entityId: id, orderId: id, details: { reason: "courier_fraud", orders: ids } });
      held++;
      continue;
    }
    if (group.length > 1) for (const f of DUPLICATE_FLAGS) flags.delete(f);
    flags.delete("courier_fraud");
    if (s.autoBookSkipFlagged && flags.size) {
      await note(ids, "Not auto-booked: review the flags, then book manually");
      skipped++;
      continue;
    }

    const results = await bookOrders(env, db, AUTO_BOOK_USER, ids, { combine: group.length > 1 });
    for (const r of results) {
      if (r.ok) {
        booked++;
      } else {
        skipped++;
        await note([r.orderId], `Auto-booking failed: ${r.error ?? "unknown error"}`);
        await logActivity(db, "system", "courier.auto_book_failed", { entityType: "order", entityId: r.orderId, orderId: r.orderId, details: { error: r.error } });
      }
    }
  }
  return { processed: due.length, booked, skipped, held };
}

/** Claim a due timer: only one cron run can take it. */
async function claim(db: DB, id: number, now: string) {
  return db
    .update(orders)
    .set({ autoBookAt: null })
    .where(and(eq(orders.id, id), isNotNull(orders.autoBookAt), lte(orders.autoBookAt, now)))
    .returning()
    .get();
}

/** Other orders of the same customer that are confirmed and waiting for a parcel. */
export async function openSiblings(db: DB, order: Pick<OrderRow, "id" | "phone">) {
  if (!order.phone) return [];
  return db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.phone, order.phone),
        ne(orders.id, order.id),
        eq(orders.courierStage, "unbooked"),
        eq(orders.callingStatus, "confirmed"),
        isNull(orders.cancelledAt),
        isNull(orders.activeConsignmentId),
        isNull(orders.combinedIntoOrderId),
        eq(orders.archived, false),
        sql`coalesce(${orders.shopifyFulfillmentStatus}, '') not in ('fulfilled', 'partially_fulfilled', 'partial')`,
      ),
    )
    .orderBy(orders.shopCreatedAt)
    .all();
}
