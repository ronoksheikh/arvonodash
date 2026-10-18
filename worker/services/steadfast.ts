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

async function request<T>(env: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!steadfastConfigured(env)) throw new HttpError(503, "Steadfast credentials are not configured");
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
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      const retryAfter = toNumber(res.headers.get("Retry-After"), 0);
      await sleep(retryAfter ? retryAfter * 1000 : 750 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(502, `Steadfast returned a non-JSON response (${res.status})`);
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(502, "Steadfast rejected the API credentials");
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

export async function getStatusByConsignmentId(env: Env, id: string): Promise<string> {
  const res = await request<{ status: number; delivery_status?: string }>(env, "GET", `/status_by_cid/${encodeURIComponent(id)}`);
  if (!res.delivery_status) throw new HttpError(502, "Steadfast did not return a delivery status");
  return res.delivery_status;
}

export async function getStatusByInvoice(env: Env, invoice: string): Promise<string | null> {
  try {
    const res = await request<{ status: number; delivery_status?: string }>(env, "GET", `/status_by_invoice/${encodeURIComponent(invoice)}`);
    return res.delivery_status ?? null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) return null;
    throw err;
  }
}

export async function getBalance(env: Env): Promise<number> {
  const res = await request<{ status: number; current_balance: number }>(env, "GET", "/get_balance");
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

export function trackingUrl(env: Env, trackingCode: string): string {
  return `${env.STEADFAST_TRACKING_URL}${encodeURIComponent(trackingCode)}`;
}

// ---------------------------------------------------------------------------
// Status mapping

const FINAL_STATUSES = new Set(["delivered", "partial_delivered", "cancelled"]);

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
    case "delivered":
    case "delivered_approval_pending":
      return "delivered";
    case "partial_delivered":
    case "partial_delivered_approval_pending":
      return "partial_delivered";
    case "cancelled":
    case "cancelled_approval_pending":
      return wasPickedUp ? "returned" : "cancelled";
    default:
      return "issue";
  }
}

/** True once the courier has physically accepted the parcel (status moved beyond review). */
export function isPickedUpStatus(status: string): boolean {
  return status !== "in_review" && !status.startsWith("unknown") && !status.startsWith("cancelled");
}
