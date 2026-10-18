import { desc, eq, inArray, and, lte, sql } from "drizzle-orm";
import type { DB } from "../db";
import type { Env } from "../env";
import { consignments, orders, payments, syncRuns, webhookEvents } from "../db/schema";
import { fetchOrdersPage, normalizeRestOrder, shopifyConfigured } from "./shopify";
import { upsertOrder } from "./orders";
import { getSettings, getValue, setValue } from "./settings";
import { applyCourierUpdate, findConsignment } from "./courier";
import { logActivity } from "./activity";
import * as steadfast from "./steadfast";
import { nowIso, toNumber } from "../lib/util";

// ---------------------------------------------------------------------------
// Sync run bookkeeping (shown on the Sync history page)

export async function recordRun<T extends Record<string, unknown>>(db: DB, kind: string, trigger: "cron" | "manual", fn: () => Promise<T>): Promise<T> {
  const run = await db.insert(syncRuns).values({ kind, trigger, startedAt: nowIso() }).returning({ id: syncRuns.id }).get();
  try {
    const stats = await fn();
    const status = toNumber(stats.errors) > 0 || toNumber(stats.failed) > 0 ? "partial" : "success";
    await db.update(syncRuns).set({ status, stats, finishedAt: nowIso() }).where(eq(syncRuns.id, run!.id));
    return stats;
  } catch (err) {
    await db.update(syncRuns).set({ status: "failed", error: (err as Error).message, finishedAt: nowIso() }).where(eq(syncRuns.id, run!.id));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shopify historical import (resumable; a few pages per invocation)

export type ImportState = { cursor: string | null; done: boolean; imported: number; since: string | null; startedAt: string; finishedAt?: string };
const IMPORT_KEY = "shopify.import";

export async function startImport(db: DB, sinceDays: number | null) {
  const state: ImportState = {
    cursor: null,
    done: false,
    imported: 0,
    since: sinceDays ? new Date(Date.now() - sinceDays * 86_400_000).toISOString() : null,
    startedAt: nowIso(),
  };
  await setValue(db, IMPORT_KEY, state);
  return state;
}

export const getImportState = (db: DB) => getValue<ImportState>(db, IMPORT_KEY);

export async function runImportStep(env: Env, db: DB, maxPages = 4) {
  const state = await getImportState(db);
  if (!state || state.done) return { pages: 0, imported: 0, done: true };
  const appSettings = await getSettings(db);
  let pages = 0;
  let imported = 0;
  while (pages < maxPages && !state.done) {
    const page = await fetchOrdersPage(env, db, {
      after: state.cursor,
      search: state.since ? `created_at:>='${state.since}'` : undefined,
      first: 50,
    });
    for (const o of page.orders) {
      await upsertOrder(db, o, appSettings);
      imported++;
    }
    pages++;
    state.cursor = page.pageInfo.endCursor;
    state.imported += page.orders.length;
    if (!page.pageInfo.hasNextPage) {
      state.done = true;
      state.finishedAt = nowIso();
    }
    await setValue(db, IMPORT_KEY, state);
  }
  return { pages, imported, done: state.done, total: state.imported };
}

// ---------------------------------------------------------------------------
// Shopify reconciliation: catch orders whose webhooks were missed.

const RECONCILE_KEY = "shopify.reconcileWatermark";

export async function reconcileShopify(env: Env, db: DB, maxPages = 5) {
  if (!shopifyConfigured(env)) return { skipped: true };
  const appSettings = await getSettings(db);
  let watermark = (await getValue<string>(db, RECONCILE_KEY)) ?? new Date(Date.now() - 2 * 86_400_000).toISOString();
  let cursor: string | null = null;
  let updated = 0;
  let pages = 0;
  for (; pages < maxPages; pages++) {
    const page = await fetchOrdersPage(env, db, { after: cursor, search: `updated_at:>='${watermark}'`, sortKey: "UPDATED_AT", reverse: false, first: 50 });
    for (const o of page.orders) {
      const r = await upsertOrder(db, o, appSettings);
      if (!r.stale) updated++;
    }
    if (page.orders.length) watermark = page.orders[page.orders.length - 1].shopUpdatedAt;
    cursor = page.pageInfo.endCursor;
    if (!page.pageInfo.hasNextPage) break;
  }
  await setValue(db, RECONCILE_KEY, watermark);
  return { pages: pages + 1, updated, watermark };
}

// ---------------------------------------------------------------------------
// Webhook processing

export async function processShopifyEvent(db: DB, topic: string, payload: unknown) {
  const appSettings = await getSettings(db);
  const p = payload as Record<string, unknown>;
  switch (topic) {
    case "orders/create":
    case "orders/updated":
    case "orders/cancelled":
    case "orders/paid":
    case "orders/fulfilled":
    case "orders/partially_fulfilled": {
      const r = await upsertOrder(db, normalizeRestOrder(p), appSettings);
      if (topic === "orders/cancelled") {
        const order = await db.select().from(orders).where(eq(orders.id, r.id)).get();
        if (order && !["unbooked", "cancelled", "returned", "delivered"].includes(order.courierStage)) {
          await logActivity(db, "shopify", "order.cancelled_after_booking", { entityType: "order", entityId: order.id, orderId: order.id, details: { courierStage: order.courierStage } });
        }
      }
      return r.stale ? "ignored" : "processed";
    }
    case "orders/delete": {
      await db.update(orders).set({ archived: true, updatedAt: nowIso() }).where(eq(orders.shopifyId, String(p.id)));
      return "processed";
    }
    default:
      return "ignored";
  }
}

export type SteadfastWebhook = {
  notification_type?: string;
  consignment_id?: number | string;
  invoice?: string;
  tracking_code?: string;
  status?: string;
  cod_amount?: number | string | null;
  delivery_charge?: number | string | null;
  tracking_message?: string;
  updated_at?: string;
};

export async function processSteadfastEvent(db: DB, payload: SteadfastWebhook) {
  const type = payload.notification_type ?? "delivery_status";
  if (type !== "delivery_status" && type !== "tracking_update") return "ignored";
  const c = await findConsignment(db, {
    consignmentId: payload.consignment_id !== undefined && payload.consignment_id !== null ? String(payload.consignment_id) : null,
    invoice: payload.invoice ?? null,
    trackingCode: payload.tracking_code ?? null,
  });
  if (!c) throw new Error(`Unknown consignment ${payload.consignment_id ?? payload.invoice}`);
  await applyCourierUpdate(
    db,
    c,
    {
      status: type === "delivery_status" ? payload.status : null,
      message: payload.tracking_message ?? null,
      codAmount: payload.cod_amount === undefined || payload.cod_amount === null ? null : toNumber(payload.cod_amount),
      deliveryCharge: payload.delivery_charge === undefined || payload.delivery_charge === null ? null : toNumber(payload.delivery_charge),
      occurredAt: payload.updated_at ?? null,
      source: "webhook",
    },
    "steadfast",
  );
  return "processed";
}

/** Re-runs stored webhook events that failed (e.g. Steadfast update arrived before the booking response). */
export async function retryFailedWebhooks(db: DB, opts: { ids?: number[]; limit?: number } = {}) {
  const cutoff = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(
      opts.ids
        ? inArray(webhookEvents.id, opts.ids)
        : and(eq(webhookEvents.status, "failed"), lte(webhookEvents.attempts, 6), sql`${webhookEvents.receivedAt} > ${cutoff}`),
    )
    .limit(opts.limit ?? 20)
    .all();
  let ok = 0;
  let failed = 0;
  for (const ev of rows) {
    try {
      const payload = JSON.parse(ev.payload);
      const status = ev.provider === "shopify" ? await processShopifyEvent(db, ev.topic, payload) : await processSteadfastEvent(db, payload);
      await db.update(webhookEvents).set({ status, error: null, attempts: ev.attempts + 1, processedAt: nowIso() }).where(eq(webhookEvents.id, ev.id));
      ok++;
    } catch (err) {
      await db.update(webhookEvents).set({ error: (err as Error).message, attempts: ev.attempts + 1 }).where(eq(webhookEvents.id, ev.id));
      failed++;
    }
  }
  return { retried: rows.length, ok, failed };
}

// ---------------------------------------------------------------------------
// COD settlements (Steadfast payments). Response shapes are undocumented, so parse defensively.

function asList(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    for (const k of ["data", "items", "payments"]) {
      if (Array.isArray(r[k])) return r[k] as Record<string, unknown>[];
      if (r[k] && typeof r[k] === "object") {
        const inner = asList(r[k]);
        if (inner.length) return inner;
      }
    }
  }
  return [];
}

/** Collects every consignment_id mentioned anywhere in a payment detail response. */
export function collectConsignmentIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectConsignmentIds(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((k === "consignment_id" || k === "cid") && (typeof v === "number" || typeof v === "string") && String(v).trim()) out.add(String(v));
      else if (typeof v === "object") collectConsignmentIds(v, out);
    }
  }
  return out;
}

export async function syncPayments(env: Env, db: DB, maxPages = 2) {
  let seen = 0;
  let linked = 0;
  for (let page = 1; page <= maxPages; page++) {
    const list = asList(await steadfast.listPayments(env, page));
    if (!list.length) break;
    for (const p of list) {
      const id = String(p.id ?? p.payment_id ?? "");
      if (!id) continue;
      seen++;
      const now = nowIso();
      const existing = await db.select().from(payments).where(eq(payments.id, id)).get();
      const values = {
        amount: toNumber(p.amount ?? p.total ?? p.paid_amount, 0),
        status: String(p.status ?? p.status_label ?? "") || null,
        paidAt: (p.paid_at ?? p.created_at ?? null) as string | null,
        raw: p,
        updatedAt: now,
      };
      if (existing) await db.update(payments).set(values).where(eq(payments.id, id));
      else await db.insert(payments).values({ id, ...values, createdAt: now });
      if (existing?.detailsSyncedAt) continue;
      const details = await steadfast.getPayment(env, id);
      const cids = [...collectConsignmentIds(details)];
      if (cids.length) {
        const r = await db
          .update(consignments)
          .set({ paymentId: id, settledAt: values.paidAt ?? now })
          .where(inArray(consignments.consignmentId, cids))
          .returning({ id: consignments.id })
          .all();
        linked += r.length;
      }
      await db.update(payments).set({ consignmentCount: cids.length, detailsSyncedAt: now }).where(eq(payments.id, id));
    }
  }
  return { payments: seen, linkedConsignments: linked };
}

export async function latestRuns(db: DB, limit = 50) {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(limit).all();
}
