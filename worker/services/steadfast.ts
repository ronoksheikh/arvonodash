import type { Env } from "../env";
import type { CourierStage } from "../../shared/constants";
import { HttpError, sleep, toNumber } from "../lib/util";

/**
 * Steadfast Courier (Packzy) merchant API client.
 * Base URL https://portal.packzy.com/api/v1, auth via Api-Key / Secret-Key headers.
 * Only documented endpoints are used.
 */

export function steadfastConfigured(env: Env): boolean {
  return Boolean(env.STEADFAST_API_KEY && env.STEADFAST_SECRET_KEY);
}

// ---------------------------------------------------------------------------
// Lockout guard. Steadfast answers 429 for rate limits, and after 10 failed logins in 5 minutes it
// refuses *every* request for 60 minutes. So: one 429 pauses all calls for the time it asks, and a
// rejected key pauses calls until the keys are changed (or 15 minutes pass, or someone presses Test).

const GUARD_KEY = "steadfast.guard";
const AUTH_PAUSE_MS = 15 * 60_000;
type Guard = { until: string; reason: "rate_limited" | "auth_failed"; key: string; message: string };
let guardCache: { at: number; guard: Guard | null } | null = null;

const keyFingerprint = (env: Env) => (env.STEADFAST_API_KEY ?? "").slice(-6);

async function readGuard(env: Env): Promise<Guard | null> {
  if (guardCache && Date.now() - guardCache.at < 5_000) return guardCache.guard;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(GUARD_KEY).first<{ value: string }>();
  const guard = row?.value ? (JSON.parse(row.value) as Guard | null) : null;
  guardCache = { at: Date.now(), guard };
  return guard;
}

async function writeGuard(env: Env, guard: Guard | null) {
  guardCache = { at: Date.now(), guard };
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(GUARD_KEY, JSON.stringify(guard), new Date().toISOString())
    .run();
}

/** Current pause, if any (shown as a banner in the dashboard). Changing the keys lifts an auth pause. */
export async function steadfastPause(env: Env): Promise<Guard | null> {
  const g = await readGuard(env);
  if (!g || g.until <= new Date().toISOString()) return null;
  if (g.reason === "auth_failed" && g.key !== keyFingerprint(env)) return null;
  return g;
}

export async function clearSteadfastPause(env: Env) {
  if (await readGuard(env)) await writeGuard(env, null);
}

async function request<T>(env: Env, method: "GET" | "POST", path: string, body?: unknown, opts: { force?: boolean } = {}): Promise<T> {
  if (!steadfastConfigured(env)) throw new HttpError(503, "Steadfast credentials are not configured");
  const paused = opts.force ? null : await steadfastPause(env);
  if (paused) throw new HttpError(503, `Steadfast calls are paused until ${paused.until}: ${paused.message}`);
  const url = `${env.STEADFAST_BASE_URL.replace(/\/$/, "")}${path}`;
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "Api-Key": env.STEADFAST_API_KEY!,
          "Secret-Key": env.STEADFAST_SECRET_KEY!,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      lastError = `network error: ${(err as Error).message}`;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 429) {
      // Never hammer a rate limit: pause every Steadfast call for as long as it asks (default 60s).
      const seconds = Math.min(3600, toNumber(res.headers.get("Retry-After"), 60) || 60);
      const until = new Date(Date.now() + seconds * 1000).toISOString();
      await writeGuard(env, { until, reason: "rate_limited", key: keyFingerprint(env), message: "Steadfast asked us to slow down (429)" });
      throw new HttpError(503, `Steadfast is rate-limiting requests; paused until ${until}`);
    }
    if (res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      await sleep(750 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(502, `Steadfast returned a non-JSON response (${res.status})`);
    }
    if (res.status === 401) {
      const until = new Date(Date.now() + AUTH_PAUSE_MS).toISOString();
      await writeGuard(env, { until, reason: "auth_failed", key: keyFingerprint(env), message: "Steadfast rejected the API keys. Update them in Settings → Connections." });
      throw new HttpError(502, "Steadfast rejected the API credentials");
    }
    if (res.status === 403) throw new HttpError(502, "Steadfast refused the request: the account is inactive or its ownership (KYC) details need resubmitting");
    if (opts.force && (await readGuard(env))) await writeGuard(env, null);
    if (!res.ok) throw new HttpError(422, extractError(json) ?? `Steadfast error ${res.status}`, json);
    return json as T;
  }
  throw new HttpError(503, `Steadfast is unavailable (${lastError}); try again shortly`);
}

function extractError(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (j.errors && typeof j.errors === "object") {
    return Object.entries(j.errors as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
      .join("; ");
  }
  return typeof j.message === "string" ? j.message : null;
}

export type CreateOrderInput = {
  invoice: string;
  recipient_name: string;
  recipient_phone: string;
  alternative_phone?: string;
  recipient_email?: string;
  recipient_address: string;
  cod_amount: number;
  note?: string;
  item_description?: string;
  total_lot?: number;
  delivery_type?: 0 | 1;
};

export type CreatedConsignment = {
  consignment_id: number | string;
  invoice: string;
  tracking_code: string;
  status: string;
  cod_amount?: number | string;
};

export async function createOrder(env: Env, input: CreateOrderInput): Promise<CreatedConsignment> {
  const res = await request<{ status: number; message?: string; consignment?: CreatedConsignment; errors?: unknown }>(
    env,
    "POST",
    "/create_order",
    input,
  );
  if (res.status !== 200 || !res.consignment) {
    throw new HttpError(422, extractError(res) ?? res.message ?? "Steadfast did not create the consignment", res);
  }
  return res.consignment;
}

export type BulkResultItem = {
  invoice: string;
  consignment_id: number | string | null;
  tracking_code: string | null;
  status: string; // success | error
  error?: string;
};

/** Up to 500 orders per call. The body field `data` is a JSON-encoded array (per the Steadfast docs). */
export async function createBulkOrders(env: Env, items: CreateOrderInput[]): Promise<BulkResultItem[]> {
  if (items.length > 500) throw new HttpError(400, "Steadfast bulk booking accepts at most 500 orders per request");
  const res = await request<unknown>(env, "POST", "/create_order/bulk-order", { data: JSON.stringify(items) });
  // The docs show both a bare array and a { data: [...] } wrapper.
  const list = Array.isArray(res) ? res : Array.isArray((res as { data?: unknown }).data) ? (res as { data: unknown[] }).data : null;
  if (!list) throw new HttpError(502, extractError(res) ?? "Unexpected bulk booking response from Steadfast", res);
  return list as BulkResultItem[];
}

/** null = Steadfast no longer knows this parcel (deleted in the portal). */
export type ParcelStatus = string | null;

/** A 404 / "not found" answer means the consignment was deleted in the Steadfast portal. */
function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 422 && /not\s*found|no\s+consignment|invalid|does not exist/i.test(err.message);
}

async function statusAt(env: Env, path: string): Promise<ParcelStatus | undefined> {
  try {
    const res = await request<{ status?: number; delivery_status?: string; message?: string }>(env, "GET", path);
    if (res.delivery_status) return res.delivery_status;
    if (Number(res.status) === 404 || /not\s*found/i.test(res.message ?? "")) return null;
    return undefined; // answered, but without a status: try again later
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Status by invoice (null when unknown to Steadfast or not answered). */
export async function getStatusByInvoice(env: Env, invoice: string): Promise<string | null> {
  return (await getParcelStatus(env, { invoice })) ?? null;
}

/** Current raw status; null when Steadfast says the parcel doesn't exist; undefined when it gave no answer. */
export async function getParcelStatus(env: Env, ref: { consignmentId?: string | null; trackingCode?: string | null; invoice: string }): Promise<ParcelStatus | undefined> {
  if (ref.consignmentId) return statusAt(env, `/status_by_cid/${encodeURIComponent(ref.consignmentId)}`);
  if (ref.trackingCode) return statusAt(env, `/status_by_trackingcode/${encodeURIComponent(ref.trackingCode)}`);
  return statusAt(env, `/status_by_invoice/${encodeURIComponent(ref.invoice)}`);
}

/** `force` = a person pressed "Test connection": try even while paused. */
export async function getBalance(env: Env, opts: { force?: boolean } = {}): Promise<number> {
  const res = await request<{ status: number; current_balance: number }>(env, "GET", "/get_balance", undefined, opts);
  return toNumber(res.current_balance);
}

export type ReturnRequest = { id: number | string; consignment_id?: number | string; reason?: string | null; status: string; created_at?: string; updated_at?: string };

export async function createReturnRequest(env: Env, consignmentId: string, reason?: string): Promise<ReturnRequest> {
  return request<ReturnRequest>(env, "POST", "/create_return_request", { consignment_id: Number(consignmentId) || consignmentId, reason });
}

export async function getReturnRequest(env: Env, id: string): Promise<ReturnRequest> {
  return request<ReturnRequest>(env, "GET", `/get_return_request/${encodeURIComponent(id)}`);
}

/** Payment endpoints return undocumented shapes; callers treat the result defensively. */
export async function listPayments(env: Env, page = 1): Promise<unknown> {
  return request<unknown>(env, "GET", `/payments?page=${page}`);
}

export async function getPayment(env: Env, id: string): Promise<unknown> {
  return request<unknown>(env, "GET", `/payments/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Fraud check: a phone number's delivery record across all Steadfast merchants.

export type FraudScore = {
  deliveryRatio: number | null; // % of finished parcels delivered; null when nothing finished
  cancellationRatio: number | null;
  volumeBand: string; // none | low | medium | high | very_high
  totalParcels: number | null; // only if Steadfast reports counts
  totalReports: number;
  categories: string[];
  doubtfulReports: boolean;
  score: number | null; // Steadfast's own score; null while they have scoring disabled
  level: string | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Accepts the documented shape and older count-based shapes, with or without a `data` wrapper. */
export function normalizeFraudScore(json: unknown): FraudScore {
  const root = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const d = (root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : root) as Record<string, unknown>;
  const delivered = num(d.total_delivered ?? d.delivered);
  const cancelled = num(d.total_cancelled ?? d.cancelled);
  const parcels = num(d.total_parcels ?? d.total) ?? (delivered !== null || cancelled !== null ? (delivered ?? 0) + (cancelled ?? 0) : null);
  const finished = (delivered ?? 0) + (cancelled ?? 0);
  const ratio = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  let deliveryRatio = ratio(num(d.delivery_ratio ?? d.success_ratio));
  let cancellationRatio = ratio(num(d.cancellation_ratio ?? d.cancel_ratio));
  if (deliveryRatio === null && finished > 0) deliveryRatio = ratio(((delivered ?? 0) / finished) * 100);
  if (cancellationRatio === null && finished > 0) cancellationRatio = ratio(((cancelled ?? 0) / finished) * 100);
  const reportsField = d.total_reports ?? d.total_fraud_reports ?? d.fraud_reports;
  const categories = (Array.isArray(d.fraud_categories) ? d.fraud_categories : [])
    .map((c) => (typeof c === "string" ? c : c && typeof c === "object" ? String((c as Record<string, unknown>).name ?? (c as Record<string, unknown>).category ?? "") : ""))
    .filter(Boolean);
  return {
    deliveryRatio,
    cancellationRatio,
    volumeBand: typeof d.volume_band === "string" ? d.volume_band : parcels === null ? "none" : parcels === 0 ? "none" : parcels < 5 ? "low" : parcels < 20 ? "medium" : "high",
    totalParcels: parcels,
    totalReports: Array.isArray(reportsField) ? reportsField.length : (num(reportsField) ?? 0),
    categories,
    doubtfulReports: Boolean(d.doubtful_reports),
    score: num(d.score),
    level: typeof d.level === "string" ? d.level : null,
  };
}

export async function getFraudScore(env: Env, phone: string): Promise<{ score: FraudScore; raw: unknown }> {
  const raw = await request<unknown>(env, "GET", `/fraud_check/score/${encodeURIComponent(phone)}`);
  return { score: normalizeFraudScore(raw), raw };
}

// ---------------------------------------------------------------------------
// Full tracking history of a parcel (every step, not just the current status).

export type TrackingStep = { consignmentId: string | null; text: string; at: string | null; type: number | null };

export async function getTrackingHistory(env: Env, invoice: string): Promise<TrackingStep[]> {
  let raw: unknown;
  try {
    raw = await request<unknown>(env, "GET", `/trackings_by_invoice/${encodeURIComponent(invoice)}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) return [];
    throw err;
  }
  const root = raw as Record<string, unknown>;
  const list = Array.isArray(raw) ? raw : Array.isArray(root?.data) ? root.data : Array.isArray(root?.trackings) ? root.trackings : [];
  return (list as Record<string, unknown>[])
    .map((t) => ({
      consignmentId: t.consignment_id !== undefined && t.consignment_id !== null ? String(t.consignment_id) : null,
      text: String(t.text ?? t.message ?? t.tracking_message ?? "").trim(),
      at: parseSteadfastTime(t.created_at ?? t.updated_at ?? t.date),
      type: num(t.tracking_type),
    }))
    .filter((t) => t.text);
}

/**
 * Steadfast timestamps such as "2025-03-02 12:45:30" carry no time zone; they are Bangladesh time.
 * ISO strings with a zone are used as they are.
 */
export function parseSteadfastTime(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const zoned = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const t = Date.parse(zoned ? s : `${s.replace(" ", "T")}+06:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function trackingUrl(env: Env, trackingCode: string): string {
  return `${env.STEADFAST_TRACKING_URL}${encodeURIComponent(trackingCode)}`;
}

// ---------------------------------------------------------------------------
// Status mapping

const FINAL_STATUSES = new Set(["delivered", "partial_delivered", "cancelled", "deleted"]);

export function isFinalStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

/**
 * Maps a raw Steadfast status to a dashboard courier stage.
 * A cancellation before the courier ever accepted the parcel is a booking cancellation;
 * after pickup it is a return to the merchant.
 */
export function stageForStatus(status: string, wasPickedUp: boolean): CourierStage {
  switch (status) {
    case "in_review":
      return "booked";
    case "pending":
      return "in_transit";
    case "hold":
      return "on_hold";
    // "_approval_pending" is the rider's word only; money and final outcomes wait for Steadfast.
    case "delivered_approval_pending":
    case "partial_delivered_approval_pending":
    case "cancelled_approval_pending":
    case "unknown_approval_pending":
      return "awaiting_confirmation";
    case "delivered":
      return "delivered";
    case "partial_delivered":
      return "partial_delivered";
    case "cancelled":
      return wasPickedUp ? "returned" : "cancelled";
    case "deleted":
      return "cancelled";
    default:
      return "issue";
  }
}

/** True once the courier has physically accepted the parcel (status moved beyond review). */
/**
 * Whether a poll's answer may replace the status we hold. A finished parcel (delivered, cancelled,
 * deleted) never goes back to an open state from a poll, and "unknown" for a parcel the courier
 * never took is not a delivery problem: it is what Steadfast answers once the parcel is deleted.
 */
export function pollVerdict(current: { status: string; isFinal: boolean; pickedUpAt: string | null }, next: ParcelStatus): "apply" | "ignore" | "deleted" {
  // A booking still in flight isn't in Steadfast yet; "not found" there means nothing.
  if (current.status === "creating") return next === null ? "ignore" : "apply";
  // "unknown" before any pickup is how a deleted parcel looked before "deleted" existed.
  const neverTaken = !current.pickedUpAt && (current.status === "in_review" || current.status.startsWith("cancelled") || current.status === "unknown");
  if (next === null) return current.pickedUpAt || current.status === "deleted" ? "ignore" : "deleted";
  if (neverTaken && next.startsWith("unknown")) return current.status === "deleted" ? "ignore" : "deleted";
  if (current.isFinal && !isFinalStatus(next)) return "ignore";
  return "apply";
}

export function isPickedUpStatus(status: string): boolean {
  return status !== "in_review" && status !== "deleted" && !status.startsWith("unknown") && !status.startsWith("cancelled");
}
