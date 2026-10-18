import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { DB } from "../db";
import type { Env } from "../env";
import { jobs } from "../db/schema";
import { nowIso, addMinutes } from "../lib/util";
import { fulfillOrder } from "./fulfillment";
import { addOrderTags } from "./shopify";
import { refreshOrderFromShopify, syncProcessingToShopify } from "./calling";
import { markPaidAfterDelivery } from "./payments";
import { runFraudCheckJob } from "./fraud";

/**
 * Minimal D1-backed outbox for work that talks to Shopify after a courier event.
 * Jobs run immediately (via waitUntil) and are retried by the cron with exponential backoff.
 */

export type JobType = "fulfill_order" | "shopify_tag" | "shopify_processing" | "shopify_refresh" | "shopify_mark_paid" | "fraud_check";

export async function enqueueJob(db: DB, type: JobType, key: string, payload: unknown, opts: { reset?: boolean } = {}) {
  const now = nowIso();
  const inserted = await db
    .insert(jobs)
    .values({ type, key, payload, status: "pending", runAfter: now, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: jobs.id })
    .get();
  if (inserted) return inserted.id;
  if (opts.reset) {
    // Manual retry: re-arm a failed/cancelled job.
    const row = await db
      .update(jobs)
      .set({ status: "pending", attempts: 0, runAfter: now, lastError: null, updatedAt: now })
      .where(and(eq(jobs.key, key), inArray(jobs.status, ["failed", "cancelled", "done"])))
      .returning({ id: jobs.id })
      .get();
    return row?.id ?? null;
  }
  return null;
}

async function runJob(env: Env, db: DB, job: typeof jobs.$inferSelect) {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  switch (job.type as JobType) {
    case "fulfill_order":
      await fulfillOrder(env, db, Number(payload.orderId), Number(payload.consignmentRowId));
      return;
    case "shopify_tag":
      await addOrderTags(env, db, String(payload.shopifyOrderId), payload.tags as string[]);
      return;
    case "shopify_processing":
      await syncProcessingToShopify(env, db, Number(payload.orderId));
      return;
    case "shopify_refresh":
      await refreshOrderFromShopify(env, db, String(payload.shopifyOrderId));
      return;
    case "shopify_mark_paid":
      await markPaidAfterDelivery(env, db, Number(payload.orderId), Number(payload.consignmentRowId));
      return;
    case "fraud_check":
      await runFraudCheckJob(env, db, String(payload.phone));
      return;
    default:
      throw new Error(`Unknown job type ${job.type}`);
  }
}

/** Claims and runs due jobs. Safe to call concurrently: claiming is a conditional update. */
export async function processJobs(env: Env, db: DB, opts: { limit?: number; ids?: number[] } = {}) {
  const now = nowIso();
  // Recover jobs stuck in "running" (e.g. the isolate was evicted mid-run).
  await db
    .update(jobs)
    .set({ status: "pending" })
    .where(and(eq(jobs.status, "running"), lte(jobs.updatedAt, addMinutes(new Date(), -10).toISOString())));

  const due = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, now), opts.ids ? inArray(jobs.id, opts.ids) : undefined))
    .orderBy(jobs.runAfter)
    .limit(opts.limit ?? 25)
    .all();

  let done = 0;
  let failed = 0;
  for (const job of due) {
    const claimed = await db
      .update(jobs)
      .set({ status: "running", attempts: sql`${jobs.attempts} + 1`, updatedAt: nowIso() })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
      .returning({ attempts: jobs.attempts })
      .get();
    if (!claimed) continue;
    try {
      await runJob(env, db, job);
      await db.update(jobs).set({ status: "done", lastError: null, updatedAt: nowIso() }).where(eq(jobs.id, job.id));
      done++;
    } catch (err) {
      failed++;
      const message = (err as Error).message ?? String(err);
      const giveUp = claimed.attempts >= job.maxAttempts || (err as { permanent?: boolean }).permanent;
      await db
        .update(jobs)
        .set({
          status: giveUp ? "failed" : "pending",
          lastError: message.slice(0, 1000),
          runAfter: addMinutes(new Date(), Math.min(2 ** claimed.attempts, 240)).toISOString(),
          updatedAt: nowIso(),
        })
        .where(eq(jobs.id, job.id));
    }
  }
  return { processed: due.length, done, failed };
}
