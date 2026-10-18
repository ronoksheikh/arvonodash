import { and, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "../db";
import type { Env } from "../env";
import { fraudChecks, orders } from "../db/schema";
import { HttpError, normalizeBdPhone, nowIso } from "../lib/util";
import { getFraudScore, steadfastConfigured, type FraudScore } from "./steadfast";
import { getSettings, getValue, setValue, type AppSettings } from "./settings";

/**
 * Steadfast fraud check: a customer's delivery record across every Steadfast merchant.
 *
 * Limits are respected three ways: each phone is looked up at most once per cache window
 * (default 24h), we cap ourselves at `fraudMaxPerMinute` lookups, and any 429 pauses all
 * Steadfast calls (see steadfast.ts). Lookups over budget wait for the job queue.
 */

export type FraudRow = typeof fraudChecks.$inferSelect;
export type FraudVerdict = "good" | "new" | "watch" | "risky" | "unknown";

/** Our reading of the numbers (Steadfast's own score is disabled for now). */
export function judgeFraud(r: Pick<FraudScore, "deliveryRatio" | "totalReports" | "doubtfulReports" | "volumeBand">, s: AppSettings): { verdict: FraudVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const confirmedReports = r.doubtfulReports ? 0 : r.totalReports;
  if (s.fraudHoldOnReports && confirmedReports > 0) reasons.push(`${confirmedReports} fraud report(s) from other merchants`);
  if (r.deliveryRatio !== null && r.deliveryRatio < s.fraudMinDeliveryRatio) reasons.push(`only ${r.deliveryRatio}% of parcels delivered`);
  if (reasons.length) return { verdict: "risky", reasons };
  if (r.deliveryRatio === null) {
    return s.fraudHoldNewCustomers ? { verdict: "risky", reasons: ["no Steadfast delivery history"] } : { verdict: "new", reasons: ["no Steadfast delivery history yet"] };
  }
  if (r.totalReports > 0) return { verdict: "watch", reasons: [`${r.totalReports} doubtful report(s)`] };
  if (r.deliveryRatio < s.fraudMinDeliveryRatio + 15) return { verdict: "watch", reasons: [`${r.deliveryRatio}% delivered`] };
  return { verdict: "good", reasons: [`${r.deliveryRatio}% delivered`] };
}

export async function getFraudCheck(db: DB, phone: string | null | undefined): Promise<FraudRow | null> {
  const p = normalizeBdPhone(phone);
  if (!p) return null;
  return (await db.select().from(fraudChecks).where(eq(fraudChecks.phone, p)).get()) ?? null;
}

/** Self-imposed per-minute budget, shared by every isolate through D1. */
async function takeBudget(db: DB, max: number): Promise<boolean> {
  const minute = new Date().toISOString().slice(0, 16);
  const cur = await getValue<{ minute: string; used: number }>(db, "fraud.budget");
  const used = cur?.minute === minute ? cur.used : 0;
  if (used >= max) return false;
  await setValue(db, "fraud.budget", { minute, used: used + 1 });
  return true;
}

export type FraudLookup = { row: FraudRow | null; deferred: boolean };

/**
 * Returns a fresh result for the phone, asking Steadfast only when the cached one is older than
 * the cache window (or `force`, which still honours the per-minute budget and any pause).
 */
export async function ensureFraudCheck(env: Env, db: DB, phoneInput: string | null | undefined, opts: { force?: boolean } = {}): Promise<FraudLookup> {
  const phone = normalizeBdPhone(phoneInput);
  if (!phone) return { row: null, deferred: false };
  const s = await getSettings(db);
  const cached = await getFraudCheck(db, phone);
  const fresh = cached?.status === "ok" && Date.now() - Date.parse(cached.checkedAt) < s.fraudCacheHours * 3_600_000;
  if ((fresh && !opts.force) || !s.fraudCheckEnabled || !steadfastConfigured(env)) return { row: cached, deferred: false };
  if (opts.force && cached && Date.now() - Date.parse(cached.checkedAt) < 60_000) return { row: cached, deferred: false };
  if (!(await takeBudget(db, s.fraudMaxPerMinute))) return { row: cached, deferred: true };

  const now = nowIso();
  try {
    const { score, raw } = await getFraudScore(env, phone);
    const { verdict } = judgeFraud(score, s);
    const values = {
      phone,
      status: "ok",
      deliveryRatio: score.deliveryRatio,
      cancellationRatio: score.cancellationRatio,
      volumeBand: score.volumeBand,
      totalParcels: score.totalParcels,
      totalReports: score.totalReports,
      categories: score.categories,
      doubtfulReports: score.doubtfulReports,
      score: score.score,
      level: score.level,
      verdict,
      error: null,
      raw,
      checkedAt: now,
    };
    await db.insert(fraudChecks).values(values).onConflictDoUpdate({ target: fraudChecks.phone, set: values });
  } catch (err) {
    // Paused / rate-limited: keep any earlier result and try again later.
    if (err instanceof HttpError && err.status === 503) return { row: cached, deferred: true };
    const message = (err as Error).message.slice(0, 300);
    if (cached?.status === "ok") {
      await db.update(fraudChecks).set({ error: message }).where(eq(fraudChecks.phone, phone));
    } else {
      const values = { phone, status: "error", verdict: "unknown", error: message, checkedAt: now, totalReports: 0, doubtfulReports: false };
      await db.insert(fraudChecks).values(values).onConflictDoUpdate({ target: fraudChecks.phone, set: values });
    }
  }
  await refreshOpenOrderFlags(db, phone);
  return { row: await getFraudCheck(db, phone), deferred: false };
}

/** Re-evaluate risk flags of this customer's orders that are still waiting to be booked. */
async function refreshOpenOrderFlags(db: DB, phone: string) {
  const { refreshRiskFlags } = await import("./orders");
  const s = await getSettings(db);
  const open = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.phone, phone), eq(orders.courierStage, "unbooked"), isNull(orders.cancelledAt), eq(orders.archived, false)))
    .all();
  for (const o of open) await refreshRiskFlags(db, o.id, s);
}

/** Job runner: a deferred lookup throws so the queue retries it with backoff. */
export async function runFraudCheckJob(env: Env, db: DB, phone: string) {
  const r = await ensureFraudCheck(env, db, phone);
  if (r.deferred) throw new Error("Fraud check deferred (rate budget or Steadfast pause); will retry");
}

/** Queue a lookup for a new order. One job per phone per cache window. */
export async function queueFraudCheck(db: DB, phoneInput: string | null | undefined) {
  const phone = normalizeBdPhone(phoneInput);
  if (!phone) return;
  const s = await getSettings(db);
  if (!s.fraudCheckEnabled) return;
  const cached = await getFraudCheck(db, phone);
  if (cached?.status === "ok" && Date.now() - Date.parse(cached.checkedAt) < s.fraudCacheHours * 3_600_000) return;
  const { enqueueJob } = await import("./jobs");
  const window = Math.floor(Date.now() / (Math.max(1, s.fraudCacheHours) * 3_600_000));
  await enqueueJob(db, "fraud_check", `fraud:${phone}:${window}`, { phone });
}

/** Fraud summary for API responses (list rows, order drawer). */
export function fraudSummary(row: FraudRow | null, s: AppSettings) {
  if (!row) return null;
  const judged = row.status === "ok" ? judgeFraud({ deliveryRatio: row.deliveryRatio, totalReports: row.totalReports, doubtfulReports: row.doubtfulReports, volumeBand: row.volumeBand ?? "none" }, s) : { verdict: "unknown" as const, reasons: [] };
  return {
    status: row.status,
    verdict: judged.verdict,
    reasons: judged.reasons,
    deliveryRatio: row.deliveryRatio,
    cancellationRatio: row.cancellationRatio,
    volumeBand: row.volumeBand,
    totalParcels: row.totalParcels,
    totalReports: row.totalReports,
    doubtfulReports: row.doubtfulReports,
    categories: row.categories ?? [],
    error: row.error,
    checkedAt: row.checkedAt,
  };
}
export type FraudSummary = NonNullable<ReturnType<typeof fraudSummary>>;

/** SQL fragment: phone of the order has a risky fraud verdict stored (used for the "Call first" tab). */
export const RISKY_FRAUD_SQL = sql`exists (select 1 from json_each(coalesce(${orders.riskFlags}, '[]')) where value = 'courier_fraud')`;
