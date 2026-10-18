import { desc, eq, and, inArray, lte, or, sql } from "drizzle-orm";
import { inList, type DB } from "../db";
import type { Env } from "../env";
import { consignments, orderNotes, orders, payments, returns, syncRuns, trackingEvents, webhookEvents } from "../db/schema";
import { fetchOrdersPage, normalizeRestOrder, shopifyConfigured, shopifyGraphql } from "./shopify";
import { markDeletedInShopify, refreshRiskFlags, upsertOrder } from "./orders";
import { getSettings, getValue, setValue } from "./settings";
import { applyCourierUpdate, findConsignment } from "./courier";
import { logActivity } from "./activity";
import { matchByInvoice } from "./legacy";
import { parseSteadfastTime, steadfastConfigured } from "./steadfast";
import { enqueueJob } from "./jobs";
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

export type ImportState = { cursor: string | null; done: boolean; imported: number; since: string | null; startedAt: string; finishedAt?: string; matchSteadfast?: boolean; linked?: number };
const IMPORT_KEY = "shopify.import";

export async function startImport(db: DB, sinceDays: number | null, matchSteadfast = true) {
  const state: ImportState = {
    matchSteadfast,
    linked: 0,
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
      const r = await upsertOrder(db, o, appSettings);
      if (state.matchSteadfast && steadfastConfigured(env)) {
        try {
          if (await matchByInvoice(env, db, r.id)) state.linked = (state.linked ?? 0) + 1;
        } catch {
          // Matching is best-effort; the order simply stays in the calling queue.
        }
      }
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
      // REST payloads can't express states like "In progress"; re-read the order via GraphQL.
      if (!r.stale && topic === "orders/updated") {
        await enqueueJob(db, "shopify_refresh", `refresh:${p.id}:${p.updated_at}`, { shopifyOrderId: String(p.id) });
      }
      if (topic === "orders/cancelled") {
        const order = await db.select().from(orders).where(eq(orders.id, r.id)).get();
        if (order && !["unbooked", "cancelled", "returned", "delivered"].includes(order.courierStage)) {
          await logActivity(db, "shopify", "order.cancelled_after_booking", { entityType: "order", entityId: order.id, orderId: order.id, details: { courierStage: order.courierStage } });
        }
      }
      return r.stale ? "ignored" : "processed";
    }
    case "orders/delete": {
      await markDeletedInShopify(db, String(p.id));
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
  tracking_id?: string;
  status?: string;
  cod_amount?: number | string | null;
  delivery_charge?: number | string | null;
  tracking_message?: string;
  updated_at?: string;
  // consignment_update
  changed?: string[];
  values?: Record<string, unknown>;
  // cancel_request / return_request
  cancel_request_id?: number | string;
  return_request_id?: number | string;
  reason?: string;
  reason_id?: number | string;
  note?: string;
  verify_status?: string;
  // return_list_accepted / payment_request
  return_list_id?: number | string;
  item_count?: number;
  consignments?: unknown[];
  payment_request_id?: number | string;
  amount?: number | string;
};

/** Events about one parcel (they must carry its consignment id, invoice or tracking code). */
export const STEADFAST_PARCEL_EVENTS = new Set(["delivery_status", "tracking_update", "consignment_update", "cancel_request", "return_request"]);

/** Steadfast field names in consignment_update → our consignment columns. */
const PORTAL_FIELDS: Record<string, { column: "recipientAddress" | "recipientName" | "recipientPhone" | "codAmount" | "note"; label: string }> = {
  cus_address: { column: "recipientAddress", label: "address" },
  recipient_address: { column: "recipientAddress", label: "address" },
  cus_name: { column: "recipientName", label: "name" },
  recipient_name: { column: "recipientName", label: "name" },
  cus_phone: { column: "recipientPhone", label: "phone" },
  recipient_phone: { column: "recipientPhone", label: "phone" },
  cod_amount: { column: "codAmount", label: "COD" },
  cod: { column: "codAmount", label: "COD" },
  note: { column: "note", label: "note" },
};

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));

export async function processSteadfastEvent(db: DB, payload: SteadfastWebhook) {
  const type = payload.notification_type ?? "delivery_status";
  if (type === "return_list_accepted") return returnListAccepted(db, payload);
  if (type === "payment_request") return "processed"; // the route pulls the payout from the API
  if (!STEADFAST_PARCEL_EVENTS.has(type)) return "ignored"; // pickup_request, user_update: stored for the log

  const c = await findConsignment(db, {
    consignmentId: str(payload.consignment_id),
    invoice: payload.invoice ?? null,
    trackingCode: payload.tracking_code ?? payload.tracking_id ?? null,
  });
  if (!c) throw new Error(`Unknown consignment ${payload.consignment_id ?? payload.invoice}`);
  const at = parseSteadfastTime(payload.updated_at) ?? nowIso();

  switch (type) {
    case "consignment_update":
      return portalChange(db, c, payload, at);
    case "cancel_request":
    case "return_request":
      return parcelRequest(db, c, type, payload, at);
    default:
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
}

type ConsignmentRow = typeof consignments.$inferSelect;

async function addParcelEvent(db: DB, c: ConsignmentRow, message: string, at: string) {
  await db.insert(trackingEvents).values({ consignmentRowId: c.id, orderId: c.orderId, kind: "system", status: null, message, source: "webhook", occurredAt: at, createdAt: nowIso() });
}

/** Someone edited the parcel in the Steadfast portal: keep our copy in step and flag a changed COD. */
async function portalChange(db: DB, c: ConsignmentRow, p: SteadfastWebhook, at: string) {
  const values = p.values ?? {};
  const patch: Partial<ConsignmentRow> = { updatedAt: nowIso() };
  const changes: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const field = PORTAL_FIELDS[key];
    if (!field || raw === undefined || raw === null) continue;
    if (field.column === "codAmount") {
      const cod = toNumber(raw, NaN);
      if (Number.isNaN(cod) || cod === c.codAmount) continue;
      patch.codAmount = cod;
      if (c.codChangedFrom === null) patch.codChangedFrom = c.codAmount;
      changes.push(`COD ৳${c.codAmount} → ৳${cod}`);
    } else {
      patch[field.column] = String(raw);
      changes.push(`${field.label} → "${String(raw)}"`);
    }
  }
  const unknown = (p.changed ?? []).filter((k) => !PORTAL_FIELDS[k]);
  if (unknown.length) changes.push(`also changed: ${unknown.join(", ")}`);
  if (!changes.length) return "ignored";
  await db.update(consignments).set(patch).where(eq(consignments.id, c.id));
  await addParcelEvent(db, c, `Changed in the Steadfast portal: ${changes.join("; ")}`, at);
  await logActivity(db, "steadfast", "courier.portal_change", { entityType: "consignment", entityId: c.consignmentId ?? c.invoice, orderId: c.orderId, details: { changes } });
  await refreshRiskFlags(db, c.orderId, await getSettings(db));
  return "processed";
}

/** A cancellation or return was requested for the parcel: show who asked and why on the order. */
async function parcelRequest(db: DB, c: ConsignmentRow, type: "cancel_request" | "return_request", p: SteadfastWebhook, at: string) {
  const reason = [p.reason, p.note].filter(Boolean).join(" — ") || "no reason given";
  const status = p.verify_status ?? p.status ?? null;
  const what = type === "cancel_request" ? "Cancellation requested" : "Return requested";
  await addParcelEvent(db, c, `${what} in Steadfast: ${reason}${status ? ` (status: ${status})` : ""}`, at);
  await db.insert(orderNotes).values({ orderId: c.orderId, kind: "internal", body: `Steadfast ${what.toLowerCase()}: ${reason}${status ? ` (${status})` : ""}`, createdAt: nowIso() });

  if (type === "return_request") {
    const id = str(p.return_request_id);
    const existing = await db
      .select({ id: returns.id })
      .from(returns)
      .where(id ? or(eq(returns.steadfastReturnId, id), eq(returns.consignmentRowId, c.id)) : eq(returns.consignmentRowId, c.id))
      .get();
    if (existing) {
      await db.update(returns).set({ steadfastReturnId: id, steadfastReturnStatus: status, updatedAt: nowIso() }).where(eq(returns.id, existing.id));
    } else {
      await db.insert(returns).values({
        orderId: c.orderId,
        consignmentRowId: c.id,
        type: "courier_return",
        reason: `Return requested in Steadfast: ${reason}`,
        status: "expected",
        steadfastReturnId: id,
        steadfastReturnStatus: status,
        followUpAction: "call_customer",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  }
  await logActivity(db, "steadfast", `courier.${type}`, { entityType: "consignment", entityId: c.consignmentId ?? c.invoice, orderId: c.orderId, details: { reason, status } });
  return "processed";
}

/** We confirmed receipt of a Steadfast return list: those returns are physically back with us. */
async function returnListAccepted(db: DB, p: SteadfastWebhook) {
  const refs = (p.consignments ?? []).map((x) => {
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return { consignmentId: str(o.consignment_id ?? o.id ?? o.cid), invoice: str(o.invoice), trackingCode: str(o.tracking_code ?? o.tracking_id) };
    }
    return { consignmentId: str(x), invoice: null, trackingCode: null };
  });
  const now = nowIso();
  let received = 0;
  for (const ref of refs) {
    const c = await findConsignment(db, ref);
    if (!c) continue;
    const open = await db.select().from(returns).where(and(eq(returns.consignmentRowId, c.id), inArray(returns.status, ["expected", "in_transit"]))).all();
    for (const r of open) {
      await db.update(returns).set({ status: "received", receivedAt: now, updatedAt: now }).where(eq(returns.id, r.id));
      received++;
    }
    if (!c.returnedAt && (c.stage === "returned" || c.stage === "partial_delivered")) await db.update(consignments).set({ returnedAt: now }).where(eq(consignments.id, c.id));
    await addParcelEvent(db, c, `Returned parcel received back (Steadfast return list ${str(p.return_list_id) ?? ""})`.trim(), now);
  }
  await logActivity(db, "steadfast", "return.list_accepted", { entityType: "return_list", entityId: str(p.return_list_id) ?? "", details: { items: refs.length, received } });
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
        ? inList(webhookEvents.id, opts.ids)
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
          .where(inList(consignments.consignmentId, cids))
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

/**
 * Re-reads recent open orders through GraphQL. Catches changes that don't fire an order webhook
 * or don't bump updated_at — notably "Mark as in progress" from the Shopify admin/mobile app.
 */
export async function syncRecentOpenOrders(env: Env, db: DB, opts: { days?: number; maxPages?: number } = {}) {
  if (!shopifyConfigured(env)) return { skipped: true };
  const appSettings = await getSettings(db);
  const since = new Date(Date.now() - (opts.days ?? 3) * 86_400_000).toISOString();
  let cursor: string | null = null;
  let seen = 0;
  for (let page = 0; page < (opts.maxPages ?? 4); page++) {
    const r = await fetchOrdersPage(env, db, { after: cursor, search: `status:open created_at:>='${since}'`, first: 50 });
    for (const o of r.orders) {
      await upsertOrder(db, o, appSettings);
      seen++;
    }
    cursor = r.pageInfo.endCursor;
    if (!r.pageInfo.hasNextPage) break;
  }
  return { checked: seen };
}

const QUICK_KEY = "sync.quickAt";

/** Called when the dashboard opens/refreshes. Throttled so many open tabs don't hammer Shopify. */
export async function quickSync(env: Env, db: DB) {
  const last = await getValue<string>(db, QUICK_KEY);
  if (last && Date.now() - Date.parse(last) < 20_000) return { skipped: true, lastAt: last };
  await setValue(db, QUICK_KEY, nowIso());
  const [reconcile, open] = await Promise.all([
    reconcileShopify(env, db, 2).catch((e: Error) => ({ error: e.message })),
    syncRecentOpenOrders(env, db, { days: 2, maxPages: 2 }).catch((e: Error) => ({ error: e.message })),
  ]);
  return { reconcile, open };
}

const EXISTS_CURSOR = "shopify.existsCursor";

/**
 * Finds orders deleted in Shopify whose orders/delete webhook never arrived: asks Shopify for our
 * live orders in batches (nodes() answers null for a deleted order). Walks the list with a cursor,
 * so every live order is checked every few runs at one cheap GraphQL call per 100 orders.
 */
export async function verifyShopifyOrdersExist(env: Env, db: DB, opts: { batches?: number } = {}) {
  if (!shopifyConfigured(env)) return { skipped: true };
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  let cursor = (await getValue<number>(db, EXISTS_CURSOR)) ?? 0;
  let scanned = 0;
  const deleted: number[] = [];
  for (let b = 0; b < (opts.batches ?? 2); b++) {
    const rows = await db
      .select({ id: orders.id, shopifyId: orders.shopifyId })
      .from(orders)
      .where(
        sql`${orders.id} > ${cursor} and ${orders.shopifyDeletedAt} is null and ${orders.archived} = 0 and ${orders.shopCreatedAt} >= ${since}
          and ${orders.courierStage} not in ('delivered', 'partial_delivered', 'returned')`,
      )
      .orderBy(orders.id)
      .limit(100)
      .all();
    if (!rows.length) {
      cursor = 0; // wrapped around; start again next run
      break;
    }
    const data = await shopifyGraphql<{ nodes: ({ id: string } | null)[] }>(env, db, `query Exists($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id } } }`, {
      ids: rows.map((r) => `gid://shopify/Order/${r.shopifyId}`),
    });
    for (let i = 0; i < rows.length; i++) {
      if (data.nodes[i] === null) {
        const r = await markDeletedInShopify(db, rows[i].shopifyId, "system");
        if (r) deleted.push(r.id);
      }
    }
    scanned += rows.length;
    cursor = rows[rows.length - 1].id;
  }
  await setValue(db, EXISTS_CURSOR, cursor);
  return { scanned, processed: deleted.length, deleted };
}
