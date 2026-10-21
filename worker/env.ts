export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_API_VERSION: string;
  STEADFAST_BASE_URL: string;
  STEADFAST_TRACKING_URL: string;
  APP_TIMEZONE_OFFSET: string;
  // Secrets
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_ACCESS_TOKEN?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
  STEADFAST_API_KEY?: string;
  STEADFAST_SECRET_KEY?: string;
  STEADFAST_WEBHOOK_TOKEN?: string;
  // Carrybee courier (entered in Settings → Connections; Worker secrets with these names override)
  CARRYBEE_CLIENT_ID?: string;
  CARRYBEE_CLIENT_SECRET?: string;
  CARRYBEE_CLIENT_CONTEXT?: string;
  CARRYBEE_WEBHOOK_SECRET?: string;
  // Test-only: point the Carrybee client at a mock server instead of the sandbox/production URL
  CARRYBEE_BASE_URL?: string;
  // Customer SMS (sms.net.bd-compatible API). Key is a Worker secret only: `wrangler secret put SMS_API_KEY`.
  SMS_API_KEY?: string;
  SMS_SENDER_ID?: string; // approved sender ID, if the account has one
  SMS_API_URL?: string; // default https://api.sms.net.bd
  // Optional: encrypts credentials saved from Settings → Connections at rest.
  APP_ENCRYPTION_KEY?: string;
  // Set by hydrateEnv: credential keys that came from real Worker secrets/vars (not the dashboard).
  CREDENTIALS_FROM_ENV?: string[];
  // Test-only: point the Shopify client at a mock server instead of https://{shop}
  SHOPIFY_ADMIN_URL_OVERRIDE?: string;
}

export type SessionUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  permissions: string[];
};

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
