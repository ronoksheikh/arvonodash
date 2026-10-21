import type { Env } from "../env";
import type { CourierStage } from "../../shared/constants";
import { HttpError, sleep, toNumber } from "../lib/util";
import { timingSafeEqual } from "../lib/crypto";

/**
 * Carrybee Delivery API v2 (https://developers.carrybee.com, sandbox https://sandbox.carrybee.com).
 * Auth: Client-ID, Client-Secret and Client-Context headers on every request. Only documented
 * endpoints are used. Off until Carrybee is chosen in Settings → Workflow → Courier.
 */

export type CarrybeeEnvironment = "sandbox" | "production";
const BASE: Record<CarrybeeEnvironment, string> = { production: "https://developers.carrybee.com", sandbox: "https://sandbox.carrybee.com" };

export function carrybeeConfigured(env: Env): boolean {
  return Boolean(env.CARRYBEE_CLIENT_ID && env.CARRYBEE_CLIENT_SECRET && env.CARRYBEE_CLIENT_CONTEXT);
}

function baseUrl(env: Env, environment: CarrybeeEnvironment) {
  return (env.CARRYBEE_BASE_URL || BASE[environment] || BASE.sandbox).replace(/\/$/, "");
}

type Envelope<T> = { error?: boolean; message?: string; data?: T; causes?: Record<string, { type?: string }[]> };

function errorText(json: Envelope<unknown>, status: number): string {
  if (json.causes && typeof json.causes === "object") {
    const parts = Object.entries(json.causes).map(([field, list]) => `${field}: ${(Array.isArray(list) ? list : []).map((x) => x?.type ?? "invalid").join(", ")}`);
    if (parts.length) return `${json.message ?? "Validation error"} (${parts.join("; ")})`;
  }
  return json.message ?? `Carrybee error ${status}`;
}

async function request<T>(env: Env, environment: CarrybeeEnvironment, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!carrybeeConfigured(env)) throw new HttpError(503, "Carrybee credentials are not configured");
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl(env, environment)}${path}`, {
        method,
        headers: {
          "Client-ID": env.CARRYBEE_CLIENT_ID!,
          "Client-Secret": env.CARRYBEE_CLIENT_SECRET!,
          "Client-Context": env.CARRYBEE_CLIENT_CONTEXT!,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      lastError = `network error: ${(err as Error).message}`;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      await sleep(750 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json: Envelope<T>;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(502, `Carrybee returned a non-JSON response (${res.status})`);
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(502, "Carrybee rejected the credentials (check Client-ID, Client-Secret, Client-Context and the environment)");
    if (res.status === 404) throw new HttpError(404, json.message ?? "Not found at Carrybee");
    if (!res.ok || json.error) throw new HttpError(422, errorText(json, res.status), json);
    return (json.data ?? null) as T;
  }
  throw new HttpError(503, `Carrybee is unavailable (${lastError}); try again shortly`);
}

// ---------------------------------------------------------------------------
// Stores & locations

export type CarrybeeStore = { id: string; name: string; address: string; is_active?: boolean; is_approved?: boolean; is_default_pickup_store?: boolean };

export async function listStores(env: Env, environment: CarrybeeEnvironment): Promise<CarrybeeStore[]> {
  const data = await request<{ stores?: CarrybeeStore[] }>(env, environment, "GET", "/api/v2/stores");
  return (data?.stores ?? []).map((s) => ({ ...s, id: String(s.id) }));
}

/** City and zone for an address string (≥10 characters). Best effort: null when Carrybee can't tell. */
export async function resolveAddress(env: Env, environment: CarrybeeEnvironment, query: string): Promise<{ city_id: number; zone_id: number } | null> {
  if (query.trim().length < 10) return null;
  try {
    const data = await request<{ city_id?: number; zone_id?: number }>(env, environment, "POST", "/api/v2/address-details", { query: query.trim().slice(0, 300) });
    return data?.city_id && data?.zone_id ? { city_id: Number(data.city_id), zone_id: Number(data.zone_id) } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orders

export type CarrybeeOrderInput = {
  store_id: string;
  merchant_order_id: string;
  delivery_type: 1 | 2;
  product_type: 1 | 2 | 3;
  recipient_phone: string;
  recipient_secendary_phone?: string; // spelling as documented
  recipient_name: string;
  recipient_address: string;
  city_id?: number;
  zone_id?: number;
  special_instruction?: string;
  product_description?: string;
  item_weight: number;
  item_quantity?: number;
  collectable_amount: number;
  is_closed_box?: boolean;
};

export type CarrybeeCreated = { consignment_id: string; collectable_amount: number; deliveryFee: number | null };

export async function createOrder(env: Env, environment: CarrybeeEnvironment, input: CarrybeeOrderInput): Promise<CarrybeeCreated> {
  const data = await request<{ order?: { consignment_id?: string; collectable_amount?: string | number; cod_fee?: number; delivery_fee?: string | number } }>(env, environment, "POST", "/api/v2/orders", input);
  const o = data?.order;
  if (!o?.consignment_id) throw new HttpError(502, "Carrybee did not return a consignment ID");
  const fee = o.delivery_fee !== undefined || o.cod_fee !== undefined ? toNumber(o.delivery_fee) + toNumber(o.cod_fee) : null;
  return { consignment_id: String(o.consignment_id), collectable_amount: toNumber(o.collectable_amount, input.collectable_amount), deliveryFee: fee };
}

export type CarrybeeDetails = {
  transfer_status?: string;
  consignment_id?: string;
  merchant_order_id?: string;
  collectable_amount?: string | number;
  collected_amount?: string | number;
  cod_fee?: number;
  delivery_fee?: string | number;
  reason?: string;
  invoice_id?: string;
  payment_status?: string;
  updated_at?: string;
};

/** By Carrybee consignment ID or our invoice (merchant order ID). null = Carrybee doesn't know it. */
export async function getOrderDetails(env: Env, environment: CarrybeeEnvironment, ref: string): Promise<CarrybeeDetails | null> {
  try {
    return await request<CarrybeeDetails>(env, environment, "GET", `/api/v2/orders/${encodeURIComponent(ref)}/details`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

export async function cancelOrder(env: Env, environment: CarrybeeEnvironment, consignmentId: string, reason: string) {
  await request<null>(env, environment, "POST", `/api/v2/orders/${encodeURIComponent(consignmentId)}/cancel`, { cancellation_reason: reason.slice(0, 190) });
}

// ---------------------------------------------------------------------------
// Status mapping. Our stored status is the webhook event without "order.".

const PICKED = new Set([
  "picked", "at-the-sorting-hub", "on-the-way-to-central-warehouse", "at-central-warehouse", "in-transit", "received-at-last-mile-hub",
  "assigned-for-delivery", "delivery-on-hold", "delivery-failed", "delivered", "partial-delivery", "paid-return", "exchange",
  "returned", "returned-at-sorting", "returned-in-transit", "returned-to-merchant",
]);
const RETURNING = new Set(["returned", "returned-at-sorting", "returned-in-transit", "returned-to-merchant"]);
const FINAL = new Set(["delivered", "partial-delivery", "paid-return", "exchange", "pickup-cancelled", "cancelled", ...RETURNING]);
/** Events that don't change the parcel's status (money, edits, failed bulk items). */
export const CARRYBEE_INFO_EVENTS = new Set(["created", "updated", "paid", "create-failed"]);
const KNOWN = new Set([...PICKED, ...FINAL, "created", "pickup-requested", "assigned-for-pickup", "pickup-failed"]);

export const carrybeeRules = {
  isPickedUp: (status: string) => PICKED.has(status),
  isFinal: (status: string) => FINAL.has(status),
  stageFor(status: string): CourierStage {
    if (status === "delivered" || status === "exchange") return "delivered";
    // paid-return: the customer paid the delivery charge and sent the product back (like Steadfast's partial).
    if (status === "partial-delivery" || status === "paid-return") return "partial_delivered";
    if (RETURNING.has(status)) return "returned";
    if (status === "pickup-cancelled" || status === "cancelled") return "cancelled";
    if (status === "delivery-on-hold" || status === "delivery-failed") return "on_hold";
    if (PICKED.has(status)) return "in_transit";
    return "booked";
  },
};

/** "order.Picked", "Picked Up", "in_transit" → our status key, or null when it isn't one we know. */
export function normalizeStatus(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase().replace(/^order\./, "").replace(/[\s_]+/g, "-");
  if (s === "picked-up") s = "picked";
  if (s === "partial-delivered") s = "partial-delivery";
  return KNOWN.has(s) || CARRYBEE_INFO_EVENTS.has(s) ? s : null;
}

/** Settings key: the last Carrybee webhook we accepted or rejected, and why. */
export const CARRYBEE_WEBHOOK_STATUS = "carrybee.webhookStatus";
export type CarrybeeWebhookStatus = { ok: boolean; at: string; reason: "mismatch" | "missing" | null; receivedHint: string | null };

/** Carrybee sends the shared secret in X-CB-Webhook-Integration-Header (no signature scheme is documented). */
export function webhookSecretMatches(env: Env, header: string | undefined): boolean {
  return Boolean(env.CARRYBEE_WEBHOOK_SECRET && header && timingSafeEqual(header.trim(), env.CARRYBEE_WEBHOOK_SECRET));
}
