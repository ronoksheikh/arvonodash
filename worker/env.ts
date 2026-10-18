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
  // Optional: encrypts credentials saved from Settings → Connections at rest.
  APP_ENCRYPTION_KEY?: string;
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
