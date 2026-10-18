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
      if (typeof patch[key] === expected) (next as Record<string, unknown>)[key] = patch[key];
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
