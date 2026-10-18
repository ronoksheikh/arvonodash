import { eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { settings } from "../db/schema";
import { nowIso } from "../lib/util";
import { DEFAULT_SMS_TEMPLATES, SMS_TRIGGERS, type FulfillmentTrigger, type SmsTrigger } from "../../shared/constants";

/** Workflow settings editable from the dashboard. Credentials never live here — they are Worker secrets. */
export type AppSettings = {
  fulfillmentTrigger: FulfillmentTrigger;
  notifyCustomer: boolean;
  trackingCompany: string;
  invoicePrefix: string;
  defaultNote: string;
  includeItemsInDescription: boolean;
  shopifyBookedTag: string;
  highValueThreshold: number;
  duplicateWindowHours: number;
  autoCreateReturns: boolean;
  autoBookEnabled: boolean;
  autoBookDelayMinutes: number;
  autoBookSkipFlagged: boolean;
  /** Orders confirmed before this local time (HH:MM, Asia/Dhaka) ship the same day. */
  cutoffTime: string;
  /** Usual courier pickup time (HH:MM), for the countdown on the pickup page. */
  pickupTime: string;
  /** Picked-up parcel with no Steadfast update for this many days is stuck. */
  stuckNoUpdateDays: number;
  /** Normal delivery time when a district has too little history to learn from. */
  transitDaysDhaka: number;
  transitDaysOutside: number;
  /** Handed to the rider but Steadfast still shows in_review after this many hours. */
  handoverConfirmHours: number;
  /** Mark COD orders paid in Shopify once Steadfast confirms the delivery. */
  markPaidOnDelivery: boolean;
  /** Steadfast fraud check (delivery record across merchants) for every new order. */
  fraudCheckEnabled: boolean;
  /** Below this delivery % the customer is risky (only when Steadfast has finished parcels). */
  fraudMinDeliveryRatio: number;
  /** Any merchant fraud report makes the customer risky. */
  fraudHoldOnReports: boolean;
  /** Customers with no Steadfast history count as risky too. */
  fraudHoldNewCustomers: boolean;
  /** Risky customers are never auto-booked: they wait in "Call first". */
  fraudHoldAutoBook: boolean;
  /** Re-use a phone's result for this long before asking Steadfast again. */
  fraudCacheHours: number;
  /** Self-imposed ceiling on fraud lookups per minute (Steadfast rate-limits them per merchant). */
  fraudMaxPerMinute: number;
  /** Auto-booking sends a customer's confirmed orders as one parcel. */
  autoCombine: boolean;
  /** Customer SMS (provider key is a Worker secret). Off until switched on in Settings. */
  smsEnabled: boolean;
  /** Which moments send an automatic SMS. */
  smsTriggers: Record<SmsTrigger, boolean>;
  /** Message per moment; {name}, {order}, {link}… are filled in per order (see SMS_VARIABLES). */
  smsTemplates: Record<SmsTrigger, string>;
  /** Public address of the tracking page, e.g. https://track.arvono.store. Empty = this dashboard's address. */
  trackingBaseUrl: string;
  /** The shop's website (logo link and "Continue shopping" on the tracking page). */
  storeUrl: string;
  businessName: string;
  businessPhone: string;
  businessAddress: string;
};

export const DEFAULT_SETTINGS: AppSettings = {
  fulfillmentTrigger: "on_pickup",
  notifyCustomer: true,
  trackingCompany: "Steadfast Courier",
  invoicePrefix: "",
  defaultNote: "",
  includeItemsInDescription: true,
  shopifyBookedTag: "steadfast-booked",
  highValueThreshold: 10000,
  duplicateWindowHours: 72,
  autoCreateReturns: true,
  autoBookEnabled: true,
  autoBookDelayMinutes: 10,
  autoBookSkipFlagged: true,
  cutoffTime: "16:00",
  pickupTime: "18:00",
  stuckNoUpdateDays: 3,
  transitDaysDhaka: 3,
  transitDaysOutside: 5,
  handoverConfirmHours: 12,
  markPaidOnDelivery: true,
  fraudCheckEnabled: true,
  fraudMinDeliveryRatio: 70,
  fraudHoldOnReports: true,
  fraudHoldNewCustomers: false,
  fraudHoldAutoBook: true,
  fraudCacheHours: 24,
  fraudMaxPerMinute: 30,
  autoCombine: true,
  smsEnabled: false,
  smsTriggers: { placed: true, confirmed: true, dispatched: true, delivered: false, on_hold: false, returned: false, cancelled: false },
  smsTemplates: DEFAULT_SMS_TEMPLATES,
  trackingBaseUrl: "",
  storeUrl: "https://arvono.store",
  businessName: "ARVONO",
  businessPhone: "",
  businessAddress: "",
};

const APP_KEY = "app";

export async function getSettings(db: DB): Promise<AppSettings> {
  const row = await db.select().from(settings).where(eq(settings.key, APP_KEY)).get();
  const saved = (row?.value as Partial<AppSettings>) ?? {};
  // Nested maps merge too, so a moment added in a later version gets its default.
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    smsTriggers: { ...DEFAULT_SETTINGS.smsTriggers, ...(saved.smsTriggers ?? {}) },
    smsTemplates: { ...DEFAULT_SETTINGS.smsTemplates, ...(saved.smsTemplates ?? {}) },
  };
}

export async function saveSettings(db: DB, patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings(db)) };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    if (key in patch && patch[key] !== undefined) {
      const expected = typeof DEFAULT_SETTINGS[key];
      if (typeof patch[key] !== expected) continue;
      if ((key === "cutoffTime" || key === "pickupTime") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch[key]))) continue;
      if (key === "smsTriggers" || key === "smsTemplates") {
        (next as Record<string, unknown>)[key] = mergeSmsMap(next[key] as Record<SmsTrigger, unknown>, patch[key], key === "smsTriggers" ? "boolean" : "string");
        continue;
      }
      if (key === "trackingBaseUrl" || key === "storeUrl") {
        const url = normalizeBaseUrl(String(patch[key]));
        if (url === null) continue;
        (next as Record<string, unknown>)[key] = url;
        continue;
      }
      if (typeof patch[key] === "number" && (!Number.isFinite(patch[key]) || (patch[key] as number) < 0)) continue;
      (next as Record<string, unknown>)[key] = patch[key];
    }
  }
  await setValue(db, APP_KEY, next);
  return next;
}

/** Only known SMS moments, with values of the right type (templates capped at 1000 characters). */
function mergeSmsMap<T>(current: Record<SmsTrigger, T>, patch: unknown, type: "boolean" | "string"): Record<SmsTrigger, T> {
  const out = { ...current };
  if (!patch || typeof patch !== "object") return out;
  for (const t of SMS_TRIGGERS) {
    const v = (patch as Record<string, unknown>)[t];
    if (typeof v === type) out[t] = (type === "string" ? String(v).slice(0, 1000) : v) as T;
  }
  return out;
}

/** "track.arvono.store" → "https://track.arvono.store". Empty clears it; anything that isn't a plain https origin is rejected (null). */
export function normalizeBaseUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

// Generic internal key/value state (sync cursors, cached tokens).
export async function getValue<T>(db: DB, key: string): Promise<T | null> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return (row?.value as T) ?? null;
}

export async function getValues(db: DB, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings).where(inArray(settings.key, keys)).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setValue(db: DB, key: string, value: unknown): Promise<void> {
  const updatedAt = nowIso();
  await db
    .insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
}
