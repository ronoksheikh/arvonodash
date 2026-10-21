import type { Env } from "../env";
import { randomToken } from "../lib/crypto";

/**
 * Connection credentials entered in Settings → Connections.
 * Stored server-side in D1 (never returned to the browser except masked). When the optional
 * APP_ENCRYPTION_KEY secret is set they are encrypted at rest with AES-GCM.
 * Worker secrets/vars with the same names still take precedence when set.
 */
export type Credentials = {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_ACCESS_TOKEN?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
  STEADFAST_API_KEY?: string;
  STEADFAST_SECRET_KEY?: string;
  STEADFAST_WEBHOOK_TOKEN?: string;
  CARRYBEE_CLIENT_ID?: string;
  CARRYBEE_CLIENT_SECRET?: string;
  CARRYBEE_CLIENT_CONTEXT?: string;
  CARRYBEE_WEBHOOK_SECRET?: string;
};

export const CREDENTIAL_KEYS: (keyof Credentials)[] = [
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_WEBHOOK_SECRET",
  "STEADFAST_API_KEY",
  "STEADFAST_SECRET_KEY",
  "STEADFAST_WEBHOOK_TOKEN",
  "CARRYBEE_CLIENT_ID",
  "CARRYBEE_CLIENT_SECRET",
  "CARRYBEE_CLIENT_CONTEXT",
  "CARRYBEE_WEBHOOK_SECRET",
];
const SECRET_KEYS = new Set<keyof Credentials>(["SHOPIFY_CLIENT_SECRET", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_WEBHOOK_SECRET", "STEADFAST_SECRET_KEY", "STEADFAST_WEBHOOK_TOKEN", "STEADFAST_API_KEY", "CARRYBEE_CLIENT_SECRET", "CARRYBEE_CLIENT_CONTEXT", "CARRYBEE_WEBHOOK_SECRET"]);

const ROW_KEY = "credentials";
let cache: { at: number; value: Credentials } | null = null;
const CACHE_MS = 5_000;

async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env: Env, value: Credentials): Promise<string> {
  const json = JSON.stringify(value);
  if (!env.APP_ENCRYPTION_KEY) return JSON.stringify({ v: 1, plain: value });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env.APP_ENCRYPTION_KEY), new TextEncoder().encode(json));
  return JSON.stringify({ v: 1, iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...new Uint8Array(data))) });
}

async function unseal(env: Env, stored: string): Promise<Credentials> {
  const box = JSON.parse(stored) as { plain?: Credentials; iv?: string; data?: string };
  if (box.plain) return box.plain;
  if (!env.APP_ENCRYPTION_KEY) throw new Error("Credentials are encrypted but APP_ENCRYPTION_KEY is not set");
  const bytes = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(box.iv!) }, await aesKey(env.APP_ENCRYPTION_KEY), bytes(box.data!));
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function loadCredentials(env: Env, fresh = false): Promise<Credentials> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(ROW_KEY).first<{ value: string }>();
  let value: Credentials = {};
  if (row?.value) {
    // settings.value is a JSON column holding the sealed string.
    const sealed = JSON.parse(row.value) as string;
    value = await unseal(env, sealed);
  }
  if (!value.STEADFAST_WEBHOOK_TOKEN || !value.CARRYBEE_WEBHOOK_SECRET) {
    // Generated once so the courier webhooks can be configured without inventing a secret.
    value = { ...value, STEADFAST_WEBHOOK_TOKEN: value.STEADFAST_WEBHOOK_TOKEN || randomToken(24), CARRYBEE_WEBHOOK_SECRET: value.CARRYBEE_WEBHOOK_SECRET || randomToken(24) };
    await saveCredentials(env, value);
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function saveCredentials(env: Env, value: Credentials) {
  const clean = Object.fromEntries(Object.entries(value).filter(([k, v]) => CREDENTIAL_KEYS.includes(k as keyof Credentials) && typeof v === "string" && v.trim())) as Credentials;
  const sealed = await seal(env, clean);
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(ROW_KEY, JSON.stringify(sealed), new Date().toISOString())
    .run();
  cache = { at: Date.now(), value: clean };
}

const isSet = (v: unknown) => typeof v === "string" && v.trim() !== "" && !v.startsWith("your-store");

/** Env with credentials from D1 filled in wherever no Worker secret/var is set. */
export async function hydrateEnv(env: Env): Promise<Env> {
  let creds: Credentials = {};
  try {
    creds = await loadCredentials(env);
  } catch (err) {
    // Before migrations ran (fresh database) or with a wrong encryption key: fall back to env only.
    console.error("credentials unavailable:", (err as Error).message);
  }
  const merged: Env = { ...env, CREDENTIALS_FROM_ENV: CREDENTIAL_KEYS.filter((k) => isSet(env[k])) };
  for (const k of CREDENTIAL_KEYS) {
    if (!isSet(env[k]) && isSet(creds[k])) (merged as unknown as Record<string, unknown>)[k] = creds[k]!.trim();
  }
  if (merged.SHOPIFY_SHOP_DOMAIN) merged.SHOPIFY_SHOP_DOMAIN = normalizeShopDomain(merged.SHOPIFY_SHOP_DOMAIN);
  return merged;
}

export function normalizeShopDomain(input: string): string {
  return input.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

/** What the Settings page may show: which values exist, where they come from, masked hints. */
export async function describeCredentials(env: Env) {
  const creds = await loadCredentials(env, true);
  return Object.fromEntries(
    CREDENTIAL_KEYS.map((k) => {
      // env here is already hydrated, so use the recorded origin rather than presence.
      const fromEnv = env.CREDENTIALS_FROM_ENV ? env.CREDENTIALS_FROM_ENV.includes(k) : isSet(env[k]);
      const v = fromEnv ? (env[k] as string) : creds[k];
      const secret = SECRET_KEYS.has(k);
      return [
        k,
        {
          set: isSet(v),
          source: fromEnv ? "worker_secret" : isSet(v) ? "dashboard" : null,
          hint: !isSet(v) ? null : secret ? `••••${v!.slice(-4)}` : v,
        },
      ];
    }),
  ) as Record<keyof Credentials, { set: boolean; source: "worker_secret" | "dashboard" | null; hint: string | null }>;
}
