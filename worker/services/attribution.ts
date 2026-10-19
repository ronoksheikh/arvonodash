import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { inList, type DB } from "../db";
import type { Env } from "../env";
import { orders } from "../db/schema";
import { nowIso } from "../lib/util";
import { fetchJourneys, shopifyConfigured } from "./shopify";
import { orderSource } from "./orders";
import { getValue, setValue } from "./settings";

/**
 * Fills in where each order came from using Shopify's customer journey (first/last visit, UTM tags,
 * referrer). Runs with the cron, newest orders first, 100 per Shopify call. Shopify needs a little
 * while after checkout to build the journey, so an order that isn't ready yet is simply tried again.
 * Orders older than 60 days are skipped: Shopify only shows them with the read_all_orders scope.
 */

const PAUSE_KEY = "attribution.pausedUntil";
const WINDOW_DAYS = 60;
const GIVE_UP_HOURS = 48; // still "not ready" after this: keep what the webhook told us

export async function syncAttribution(env: Env, db: DB, opts: { batches?: number } = {}) {
  if (!shopifyConfigured(env)) return { skipped: true };
  const paused = await getValue<string>(db, PAUSE_KEY);
  if (paused && paused > nowIso()) return { skipped: true, pausedUntil: paused };
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  let processed = 0;
  let waiting = 0;
  const seen = new Set<number>();
  for (let b = 0; b < (opts.batches ?? 1); b++) {
    const rows = (
      await db
        .select({ id: orders.id, shopifyId: orders.shopifyId, sourceName: orders.sourceName, attribution: orders.attribution, placed: orders.shopCreatedAt })
        .from(orders)
        .where(and(isNull(orders.attributionCheckedAt), gte(orders.shopCreatedAt, since), eq(orders.archived, false)))
        .orderBy(desc(orders.shopCreatedAt))
        .limit(100 + seen.size)
        .all()
    ).filter((r) => !seen.has(r.id)).slice(0, 100);
    if (!rows.length) break;
    let journeys;
    try {
      journeys = await fetchJourneys(env, db, rows.map((r) => r.shopifyId));
    } catch (err) {
      // Never let this hold up anything else: pause for an hour and say why on the Sync page.
      await setValue(db, PAUSE_KEY, new Date(Date.now() + 3_600_000).toISOString());
      return { processed, error: (err as Error).message };
    }
    const done: number[] = [];
    for (const r of rows) {
      seen.add(r.id);
      const j = journeys.get(r.shopifyId);
      const old = Date.now() - Date.parse(r.placed) > GIVE_UP_HOURS * 3_600_000;
      if (j === null || j === undefined) {
        done.push(r.id); // deleted in Shopify: the existence check takes care of it
        continue;
      }
      if (!j.ready && !old) {
        waiting++;
        continue;
      }
      if (j.attribution) {
        await db.update(orders).set({ ...orderSource(r.sourceName, j.attribution), attributionCheckedAt: nowIso() }).where(eq(orders.id, r.id));
        processed++;
      } else done.push(r.id);
    }
    if (done.length) await db.update(orders).set({ attributionCheckedAt: nowIso() }).where(inList(orders.id, done));
  }
  return { processed, waiting };
}
