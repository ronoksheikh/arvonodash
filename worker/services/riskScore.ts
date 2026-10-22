import { and, desc, eq, gte, inArray, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import type { DB } from "../db";
import { inList } from "../db";
import { customers, orderRisk, orders } from "../db/schema";
import { nowIso } from "../lib/util";
import { CHANNELS, type Channel } from "../../shared/attribution";
import { MIN_SAMPLE, sameAddress, sameName, scoreRisk, type GroupStat, type PreviousOrder, type PreviousOutcome, type RiskResult } from "../../shared/risk";
import { fraudSummary, getFraudCheck } from "./fraud";
import type { AppSettings } from "./settings";

/**
 * Smart risk score per order. Combines the customer's earlier orders on the same phone number
 * (received, returned, cancelled — even under another name), the Steadfast fraud check, how often
 * orders from the same ad channel / campaign / district come back, and the order's own warning flags.
 */

type Order = typeof orders.$inferSelect;

export type RiskReport = RiskResult & {
  previous: PreviousOrder[];
  channel: (GroupStat & { label: string }) | null;
  campaign: GroupStat | null;
  district: GroupStat | null;
  computedAt: string;
};

const address = (o: { address1: string | null; address2: string | null; city: string | null }) => [o.address1, o.address2, o.city].map((x) => (x ?? "").trim()).filter(Boolean).join(", ");

function outcomeOf(o: { courierStage: string; cancelledAt: string | null; callingStatus: string }): PreviousOutcome {
  if (o.courierStage === "delivered") return "delivered";
  if (o.courierStage === "partial_delivered") return "partial";
  if (o.courierStage === "returned") return "returned";
  if (o.courierStage === "cancelled") return "cancelled_at_courier";
  if (o.callingStatus === "rejected") return "rejected";
  if (o.cancelledAt) return "cancelled";
  return o.courierStage === "unbooked" ? "open" : "in_progress";
}

/** Every other order placed with this phone number, newest first, with what happened to it. */
export async function previousOrders(db: DB, order: Order, windowHours: number): Promise<PreviousOrder[]> {
  if (!order.phone) return [];
  const rows = await db
    .select({
      id: orders.id,
      name: orders.name,
      shopCreatedAt: orders.shopCreatedAt,
      total: orders.total,
      customerName: orders.customerName,
      address1: orders.address1,
      address2: orders.address2,
      city: orders.city,
      courierStage: orders.courierStage,
      cancelledAt: orders.cancelledAt,
      cancelReason: orders.cancelReason,
      callingStatus: orders.callingStatus,
      channel: orders.channel,
      combinedIntoOrderId: orders.combinedIntoOrderId,
    })
    .from(orders)
    .where(and(eq(orders.phone, order.phone), ne(orders.id, order.id)))
    .orderBy(desc(orders.shopCreatedAt))
    .limit(60)
    .all();
  const mine = address(order);
  const at = Date.parse(order.shopCreatedAt);
  return rows
    .filter((r) => r.combinedIntoOrderId !== order.id) // travels in this order's own parcel
    .map((r) => ({
      id: r.id,
      name: r.name,
      shopCreatedAt: r.shopCreatedAt,
      total: r.total,
      customerName: r.customerName,
      address: address(r),
      sameName: sameName(r.customerName, order.customerName),
      sameAddress: sameAddress(address(r), mine),
      outcome: outcomeOf(r),
      cancelReason: r.cancelReason,
      channel: r.channel,
      nearby: Math.abs(Date.parse(r.shopCreatedAt) - at) < windowHours * 3_600_000,
    }));
}

type Stats = { shopRate: number; channel: Map<string, GroupStat>; campaign: Map<string, GroupStat>; district: Map<string, GroupStat> };
let statsCache: { at: number; data: Stats } | null = null;

/** Return rates per channel, campaign and district over the last 180 days (cached for 10 minutes). */
export async function groupStats(db: DB, fresh = false): Promise<Stats> {
  if (!fresh && statsCache && Date.now() - statsCache.at < 10 * 60_000) return statsCache.data;
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const finished = and(inArray(orders.courierStage, ["delivered", "partial_delivered", "returned"]), gte(orders.shopCreatedAt, since), isNull(orders.combinedIntoOrderId));
  const returned = sql<number>`sum(case when ${orders.courierStage} = 'returned' then 1 else 0 end)`;
  const by = async (key: ReturnType<typeof sql<string | null>>) =>
    db.select({ key, finished: sql<number>`count(*)`, returned }).from(orders).where(finished).groupBy(key).all();
  const [total, channel, campaign, district] = await Promise.all([
    db.select({ finished: sql<number>`count(*)`, returned }).from(orders).where(finished).get(),
    by(sql<string | null>`coalesce(${orders.channel}, 'unknown')`),
    by(sql<string | null>`${orders.utmCampaign}`),
    by(sql<string | null>`lower(trim(${orders.city}))`),
  ]);
  const shopRate = total?.finished ? (total.returned ?? 0) / total.finished : 0;
  const toMap = (rows: { key: string | null; finished: number; returned: number | null }[]) =>
    new Map(rows.filter((r) => r.key).map((r) => [r.key!, { key: r.key!, finished: r.finished, returned: r.returned ?? 0, rate: (r.returned ?? 0) / r.finished, shopRate }]));
  const data = { shopRate, channel: toMap(channel), campaign: toMap(campaign), district: toMap(district) };
  statsCache = { at: Date.now(), data };
  return data;
}

/** Full report for one order (the drawer's Risk tab); `flags` are the order's current risk flags. */
export async function buildRiskReport(db: DB, order: Order, flags: string[], s: AppSettings): Promise<RiskReport> {
  const [previous, fraudRow, customer, stats] = await Promise.all([
    previousOrders(db, order, s.duplicateWindowHours),
    getFraudCheck(db, order.phone),
    order.customerId ? db.select({ flag: customers.flag }).from(customers).where(eq(customers.id, order.customerId)).get() : null,
    groupStats(db),
  ]);
  const fraud = fraudSummary(fraudRow, s);
  const ch = (order.channel ?? "unknown") as Channel;
  const chStat = order.channel && order.channel !== "unknown" ? stats.channel.get(order.channel) : undefined;
  const cpStat = order.utmCampaign ? stats.campaign.get(order.utmCampaign) : undefined;
  const city = order.city?.trim();
  const dStat = city ? stats.district.get(city.toLowerCase()) : undefined;
  const result = scoreRisk({
    flags,
    previous,
    fraud: fraud && fraud.status === "ok" ? fraud : null,
    customerFlag: customer?.flag ?? null,
    channel: chStat && chStat.finished >= MIN_SAMPLE.channel ? { ...chStat, label: CHANNELS[ch]?.label ?? ch } : null,
    campaign: cpStat && cpStat.finished >= MIN_SAMPLE.campaign ? cpStat : null,
    district: dStat && dStat.finished >= MIN_SAMPLE.district ? { ...dStat, key: city! } : null,
  });
  return {
    ...result,
    previous,
    channel: chStat ? { ...chStat, label: CHANNELS[ch]?.label ?? ch } : null,
    campaign: cpStat ?? null,
    district: dStat ? { ...dStat, key: city! } : null,
    computedAt: nowIso(),
  };
}

export async function saveRisk(db: DB, orderId: number, r: RiskResult) {
  const values = { orderId, score: r.score, level: r.level, headline: r.headline, factors: r.factors.slice(0, 8).map((f) => ({ key: f.key, label: f.label, points: f.points })), computedAt: nowIso() };
  await db.insert(orderRisk).values(values).onConflictDoUpdate({ target: orderRisk.orderId, set: values });
}

/** Stored scores for a page of orders (list view). */
export async function risksFor(db: DB, ids: number[]) {
  const rows = ids.length ? await db.select().from(orderRisk).where(inList(orderRisk.orderId, ids)).all() : [];
  return new Map(rows.map((r) => [r.orderId, { score: r.score, level: r.level, headline: r.headline, factors: r.factors }]));
}

/** SQL: the order's stored risk level is high (used for the "Call first" tab and the risk filter). */
export const riskLevelSql = (levels: string[]) =>
  sql`exists (select 1 from ${orderRisk} where ${orderRisk.orderId} = ${orders.id} and ${inList(orderRisk.level, levels)})`;

/** SQL: stored score, for sorting (orders without a score sort as 0). */
export const RISK_SCORE_SQL = sql<number>`coalesce((select ${orderRisk.score} from ${orderRisk} where ${orderRisk.orderId} = ${orders.id}), -1)`;

/**
 * Cron: give a score to recent orders that have none yet (open ones first), and refresh open
 * orders whose score is older than 6 hours (return rates and the customer's other orders move).
 */
export async function backfillRisk(db: DB, s: AppSettings, limit = 40) {
  const { refreshRiskFlags } = await import("./orders");
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stale = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const hasRow = db.select({ x: sql`1` }).from(orderRisk).where(eq(orderRisk.orderId, orders.id));
  const missing = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(gte(orders.shopCreatedAt, since), eq(orders.archived, false), notExists(hasRow)))
    .orderBy(sql`case when ${orders.courierStage} = 'unbooked' and ${orders.cancelledAt} is null then 0 else 1 end`, desc(orders.shopCreatedAt))
    .limit(limit)
    .all();
  const old =
    missing.length < limit
      ? await db
          .select({ id: orders.id })
          .from(orders)
          .innerJoin(orderRisk, eq(orderRisk.orderId, orders.id))
          .where(and(eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt), eq(orders.archived, false), lt(orderRisk.computedAt, stale)))
          .limit(limit - missing.length)
          .all()
      : [];
  for (const o of [...missing, ...old]) await refreshRiskFlags(db, o.id, s, { siblings: false });
  return { processed: missing.length + old.length };
}

/** Open orders of the same number: their score changes when one of this customer's orders finishes. */
export async function openSiblingIds(db: DB, phone: string, exceptId: number) {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.phone, phone), ne(orders.id, exceptId), or(eq(orders.courierStage, "unbooked"), eq(orders.courierStage, "booked")), isNull(orders.cancelledAt), eq(orders.archived, false)))
    .limit(20)
    .all();
  return rows.map((r) => r.id);
}
