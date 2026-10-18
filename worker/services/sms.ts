import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { DB } from "../db";
import type { Env } from "../env";
import { consignments, orders, smsMessages } from "../db/schema";
import { HttpError, normalizeBdPhone, nowIso, PermanentError } from "../lib/util";
import { COURIER_STAGES, SMS_ERROR_CODES, SMS_TRIGGERS, smsSegments, type SmsTrigger } from "../../shared/constants";
import { getSettings, getValue, setValue, type AppSettings } from "./settings";
import { enqueueJob } from "./jobs";
import { ensureTrackingToken, publicTrackingUrl } from "./tracking";

/**
 * Customer SMS through an sms.net.bd-compatible API (POST /sendsms with api_key, msg, to).
 * The API key is a Worker secret (SMS_API_KEY) and never leaves the server. Sending is off until
 * it is switched on in Settings; each automatic message is a job keyed by order + moment, so an
 * order never gets the same update twice, however many webhooks or polls report it.
 */

const DEFAULT_API_URL = "https://api.sms.net.bd";
const LAST_ERROR_KEY = "sms.lastError";
/** Provider codes worth retrying later (their side, not ours). */
const RETRYABLE = new Set([409]);

export function smsConfigured(env: Env): boolean {
  return Boolean(env.SMS_API_KEY);
}

const apiUrl = (env: Env, path: string) => `${(env.SMS_API_URL || DEFAULT_API_URL).replace(/\/$/, "")}${path}`;

export type SmsResult = { ok: boolean; code: number | null; message: string; requestId: string | null; retryable: boolean };

/** One provider call. Never throws: network and provider errors come back as a result. */
export async function sendRaw(env: Env, to: string, msg: string): Promise<SmsResult> {
  if (!smsConfigured(env)) return { ok: false, code: null, message: "SMS_API_KEY is not set on the server", requestId: null, retryable: false };
  const form = new URLSearchParams({ api_key: env.SMS_API_KEY!, msg, to });
  if (env.SMS_SENDER_ID) form.set("sender_id", env.SMS_SENDER_ID);
  let res: Response;
  try {
    res = await fetch(apiUrl(env, "/sendsms"), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
  } catch (err) {
    return { ok: false, code: null, message: `Network error: ${(err as Error).message}`, requestId: null, retryable: true };
  }
  if (res.status >= 500) return { ok: false, code: null, message: `SMS provider unavailable (HTTP ${res.status})`, requestId: null, retryable: true };
  let json: { error?: number | string; msg?: string; data?: { request_id?: number | string } };
  try {
    json = await res.json();
  } catch {
    return { ok: false, code: null, message: `Unexpected SMS provider response (HTTP ${res.status})`, requestId: null, retryable: true };
  }
  const code = Number(json.error ?? (res.ok ? 0 : res.status));
  const requestId = json.data?.request_id !== undefined ? String(json.data.request_id) : null;
  if (code === 0) return { ok: true, code, message: json.msg || "Sent", requestId, retryable: false };
  return { ok: false, code, message: SMS_ERROR_CODES[code] ?? json.msg ?? `SMS error ${code}`, requestId, retryable: RETRYABLE.has(code) };
}

export async function getSmsBalance(env: Env): Promise<number | null> {
  if (!smsConfigured(env)) return null;
  const res = await fetch(`${apiUrl(env, "/user/balance/")}?api_key=${encodeURIComponent(env.SMS_API_KEY!)}`, { headers: { Accept: "application/json" } });
  const json = (await res.json().catch(() => ({}))) as { error?: number; msg?: string; data?: { balance?: string | number } };
  if (Number(json.error ?? 1) !== 0) throw new HttpError(502, SMS_ERROR_CODES[Number(json.error)] ?? json.msg ?? "Could not read the SMS balance");
  const balance = Number(json.data?.balance);
  return Number.isFinite(balance) ? balance : null;
}

// ---------------------------------------------------------------------------
// Templates

/** Fills {placeholders}; unknown ones stay as typed so a typo is visible in the preview. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key] : m))
    .replace(/[ \t]+/g, " ")
    .trim();
}

type OrderRow = typeof orders.$inferSelect;

export async function smsVariables(db: DB, appSettings: AppSettings, order: OrderRow): Promise<Record<string, string>> {
  const token = order.trackingToken ?? (await ensureTrackingToken(db, order.id));
  const parcel = order.activeConsignmentId ? await db.select().from(consignments).where(eq(consignments.id, order.activeConsignmentId)).get() : null;
  // A combined parcel carries several orders: name them all, and the COD is the parcel's.
  const together = parcel
    ? (await db.select({ name: orders.name }).from(orders).where(and(eq(orders.activeConsignmentId, parcel.id), isNotNull(orders.combinedIntoOrderId))).all()).map((o) => o.name)
    : [];
  const fullName = (parcel?.recipientName || order.customerName || "").trim();
  const cod = parcel ? parcel.codAmount : order.outstanding;
  return {
    name: fullName.split(/\s+/)[0] || "there",
    full_name: fullName || "Customer",
    order: [order.name, ...together.filter((n) => n !== order.name)].join(" + "),
    link: token ? await publicTrackingUrl(db, appSettings, token) : "",
    status: COURIER_STAGES[order.courierStage as keyof typeof COURIER_STAGES]?.label ?? order.courierStage,
    address: [order.address1, order.address2, order.city].filter(Boolean).join(", "),
    cod: `Tk ${Math.round(cod).toLocaleString("en-US")}`,
    total: `Tk ${Math.round(order.total).toLocaleString("en-US")}`,
    tracking_code: parcel?.trackingCode ?? "",
    shop: appSettings.businessName,
    shop_phone: appSettings.businessPhone,
  };
}

// ---------------------------------------------------------------------------
// Automatic messages

/** Queues the automatic SMS for this moment, if switched on. Once per order and moment, ever. */
export async function queueSms(db: DB, orderId: number, trigger: SmsTrigger, appSettings?: AppSettings) {
  const s = appSettings ?? (await getSettings(db));
  if (!s.smsEnabled || !s.smsTriggers[trigger]) return null;
  return enqueueJob(db, "sms", `sms:${trigger}:${orderId}`, { orderId, trigger });
}

/** Moments that still make sense when the job runs (an order cancelled meanwhile gets no "confirmed"). */
function stillRelevant(order: OrderRow, trigger: SmsTrigger): boolean {
  if (trigger === "cancelled") return true;
  if (order.cancelledAt || order.shopifyDeletedAt) return false;
  if (trigger === "placed" || trigger === "confirmed") return order.courierStage === "unbooked" || order.courierStage === "booked";
  return true;
}

/** Job: render and send one automatic SMS. */
export async function runSmsJob(env: Env, db: DB, payload: { orderId: number; trigger: SmsTrigger }) {
  const appSettings = await getSettings(db);
  if (!appSettings.smsEnabled || !SMS_TRIGGERS.includes(payload.trigger)) return; // switched off since it was queued
  const order = await db.select().from(orders).where(eq(orders.id, payload.orderId)).get();
  if (!order || !stillRelevant(order, payload.trigger)) return;
  const body = renderTemplate(appSettings.smsTemplates[payload.trigger] ?? "", await smsVariables(db, appSettings, order));
  const r = await deliver(env, db, { orderId: order.id, phone: order.phone ?? order.rawPhone, body, trigger: payload.trigger, sentBy: "system" });
  if (!r.ok && r.retryable) throw new Error(r.message); // the job outbox retries with backoff
  if (!r.ok && r.code !== null) throw new PermanentError(r.message);
}

/** Records the message, sends it, and stores the provider's answer. */
async function deliver(env: Env, db: DB, m: { orderId: number | null; phone: string | null; body: string; trigger: string; sentBy: string }) {
  const phone = normalizeBdPhone(m.phone);
  const { segments } = smsSegments(m.body);
  const now = nowIso();
  const row = await db
    .insert(smsMessages)
    .values({ orderId: m.orderId, phone: phone ?? m.phone ?? "", body: m.body, trigger: m.trigger, status: "queued", segments: Math.max(1, segments), sentBy: m.sentBy, createdAt: now })
    .returning({ id: smsMessages.id })
    .get();
  const skip = !phone ? "Not a valid Bangladeshi mobile number" : !m.body.trim() ? "Empty message" : null;
  const r: SmsResult = skip ? { ok: false, code: null, message: skip, requestId: null, retryable: false } : await sendRaw(env, phone!, m.body);
  await db
    .update(smsMessages)
    .set({ status: r.ok ? "sent" : skip ? "skipped" : "failed", providerCode: r.code, providerMessage: r.message, requestId: r.requestId, sentAt: r.ok ? nowIso() : null })
    .where(eq(smsMessages.id, row!.id));
  // Account-level problems (balance, expiry, key) are shown in Settings until a message goes through.
  if (r.ok) {
    if (await getValue(db, LAST_ERROR_KEY)) await setValue(db, LAST_ERROR_KEY, null);
  } else if (r.code !== null && [405, 410, 411, 413, 417, 421].includes(r.code)) {
    await setValue(db, LAST_ERROR_KEY, { code: r.code, message: r.message, at: nowIso() });
  }
  return { ...r, id: row!.id, phone, segments };
}

// ---------------------------------------------------------------------------
// Manual messages (staff)

export async function sendManualSms(env: Env, db: DB, actor: { name: string }, input: { orderId?: number | null; phone?: string | null; body?: string | null; template?: SmsTrigger | null }) {
  if (!smsConfigured(env)) throw new HttpError(503, "SMS is not set up: add the SMS_API_KEY secret on the server");
  const appSettings = await getSettings(db);
  const order = input.orderId ? await db.select().from(orders).where(eq(orders.id, input.orderId)).get() : null;
  if (input.orderId && !order) throw new HttpError(404, "Order not found");
  const raw = input.body?.trim() || (input.template ? appSettings.smsTemplates[input.template] : "");
  if (!raw) throw new HttpError(400, "Write a message or pick a template");
  const body = order ? renderTemplate(raw, await smsVariables(db, appSettings, order)) : raw;
  if (body.length > 1000) throw new HttpError(400, "Message is too long (max 1000 characters)");
  const r = await deliver(env, db, { orderId: order?.id ?? null, phone: input.phone || order?.phone || order?.rawPhone || null, body, trigger: input.orderId ? "manual" : "test", sentBy: actor.name });
  if (!r.ok) throw new HttpError(422, `SMS not sent: ${r.message}`);
  return { id: r.id, phone: r.phone, segments: r.segments, body };
}

export async function smsLog(db: DB, opts: { orderId?: number; limit?: number } = {}) {
  return db
    .select({ sms: smsMessages, orderName: orders.name })
    .from(smsMessages)
    .leftJoin(orders, eq(orders.id, smsMessages.orderId))
    .where(opts.orderId ? eq(smsMessages.orderId, opts.orderId) : undefined)
    .orderBy(desc(smsMessages.createdAt), desc(smsMessages.id))
    .limit(opts.limit ?? 100)
    .all()
    .then((rows) => rows.map((r) => ({ ...r.sms, orderName: r.orderName })));
}

export async function smsStatus(env: Env, db: DB) {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await db.select({ status: smsMessages.status, segments: smsMessages.segments, createdAt: smsMessages.createdAt }).from(smsMessages).where(inArray(smsMessages.status, ["sent", "failed"])).orderBy(desc(smsMessages.createdAt)).limit(500).all();
  const today = recent.filter((r) => r.createdAt >= since);
  return {
    configured: smsConfigured(env),
    senderId: env.SMS_SENDER_ID || null,
    lastError: await getValue<{ code: number; message: string; at: string }>(db, LAST_ERROR_KEY),
    last24h: { sent: today.filter((r) => r.status === "sent").length, failed: today.filter((r) => r.status === "failed").length, segments: today.filter((r) => r.status === "sent").reduce((n, r) => n + r.segments, 0) },
  };
}
