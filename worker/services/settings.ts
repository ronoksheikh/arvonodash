import { eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { settings } from "../db/schema";
import { nowIso } from "../lib/util";
import type { FulfillmentTrigger } from "../../shared/constants";

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
  businessName: "ARVONO",
  businessPhone: "",
  businessAddress: "",
};

const APP_KEY = "app";

export async function getSettings(db: DB): Promise<AppSettings> {
  const row = await db.select().from(settings).where(eq(settings.key, APP_KEY)).get();
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) ?? {}) };
}

export async function saveSettings(db: DB, patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings(db)) };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    if (key in patch && patch[key] !== undefined) {
      const expected = typeof DEFAULT_SETTINGS[key];
      if (typeof patch[key] !== expected) continue;
      if ((key === "cutoffTime" || key === "pickupTime") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch[key]))) continue;
      if (typeof patch[key] === "number" && (!Number.isFinite(patch[key]) || (patch[key] as number) < 0)) continue;
      (next as Record<string, unknown>)[key] = patch[key];
    }
  }
  await setValue(db, APP_KEY, next);
  return next;
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
