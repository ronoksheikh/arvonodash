import type { Env } from "../env";
import type { DB } from "../db";
import type { LineItem } from "../db/schema";
import { getValue, setValue } from "./settings";
import { gidToId, sleep, toNumber, HttpError } from "../lib/util";

/**
 * Shopify GraphQL Admin API client.
 *
 * Auth: either a static Admin API token (legacy custom app, SHOPIFY_ACCESS_TOKEN) or the
 * client credentials grant for Dev Dashboard apps (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET),
 * whose tokens expire after 24h and are cached in D1.
 */

type TokenCache = { token: string; expiresAt: number };
const TOKEN_KEY = "shopify.token";
let memoryToken: TokenCache | null = null;

export function shopifyConfigured(env: Env): boolean {
  return Boolean(
    env.SHOPIFY_SHOP_DOMAIN &&
      !env.SHOPIFY_SHOP_DOMAIN.startsWith("your-store") &&
      (env.SHOPIFY_ACCESS_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)),
  );
}

function adminBase(env: Env): string {
  return env.SHOPIFY_ADMIN_URL_OVERRIDE || `https://${env.SHOPIFY_SHOP_DOMAIN}`;
}

export function shopifyAdminOrderUrl(env: Env, orderId: string): string {
  return `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/orders/${orderId}`;
}

async function getAccessToken(env: Env, db: DB, forceRefresh = false): Promise<string> {
  if (env.SHOPIFY_ACCESS_TOKEN) return env.SHOPIFY_ACCESS_TOKEN;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new HttpError(503, "Shopify credentials are not configured");
  }
  const margin = 5 * 60_000;
  if (!forceRefresh) {
    if (memoryToken && memoryToken.expiresAt - margin > Date.now()) return memoryToken.token;
    const cached = await getValue<TokenCache>(db, TOKEN_KEY);
    if (cached && cached.expiresAt - margin > Date.now()) {
      memoryToken = cached;
      return cached.token;
    }
  }
  const res = await fetch(`${adminBase(env)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(502, `Shopify token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  memoryToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  await setValue(db, TOKEN_KEY, memoryToken);
  return json.access_token;
}

type GraphQLResponse<T> = {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: { requestedQueryCost: number; throttleStatus: { currentlyAvailable: number; restoreRate: number; maximumAvailable: number } };
  };
};

/** Runs a GraphQL Admin API request with retry on throttling, 429 and 5xx responses. */
export async function shopifyGraphql<T>(env: Env, db: DB, query: string, variables?: Record<string, unknown>): Promise<T> {
  const url = `${adminBase(env)}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  let refreshed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getAccessToken(env, db, refreshed);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && !refreshed && !env.SHOPIFY_ACCESS_TOKEN) {
      refreshed = true;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = toNumber(res.headers.get("Retry-After"), 0);
      await sleep(retryAfter ? retryAfter * 1000 : 500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      throw new HttpError(502, `Shopify API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      if (json.errors.some((e) => e.extensions?.code === "THROTTLED")) {
        const t = json.extensions?.cost?.throttleStatus;
        const cost = json.extensions?.cost?.requestedQueryCost ?? 100;
        const waitMs = t ? Math.ceil(Math.max(0, cost - t.currentlyAvailable) / Math.max(t.restoreRate, 1)) * 1000 : 1000 * 2 ** attempt;
        await sleep(Math.min(waitMs + 250, 10_000));
        continue;
      }
      throw new HttpError(502, `Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    // Back off proactively when the bucket is nearly empty.
    const t = json.extensions?.cost?.throttleStatus;
    if (t && t.currentlyAvailable < t.maximumAvailable * 0.1) await sleep(1000);
    return json.data as T;
  }
  throw new HttpError(503, "Shopify API is rate limiting or unavailable; try again shortly");
}

// ---------------------------------------------------------------------------
// Normalized order shape shared by webhook (REST JSON) and GraphQL imports.

export type NormalizedOrder = {
  source: "rest" | "graphql";
  shopifyId: string;
  name: string;
  orderNumber: number | null;
  shopCreatedAt: string;
  shopUpdatedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  closedAt: string | null;
  shopifyCustomerId: string | null;
  customerName: string | null;
  rawPhone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  currency: string;
  subtotal: number;
  shippingTotal: number;
  discountTotal: number;
  total: number;
  outstanding: number;
  financialStatus: string | null;
  shopifyFulfillmentStatus: string | null;
  paymentGateways: string[];
  shippingMethod: string | null;
  lineItems: LineItem[];
  shopifyTags: string[];
  shopifyNote: string | null;
  noteAttributes: { name: string; value: string }[];
  sourceName: string | null;
};

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : null);
const joinName = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" ").trim() || null;

/** Normalizes the REST-format JSON delivered by orders/* webhooks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeRestOrder(o: any): NormalizedOrder {
  const ship = o.shipping_address ?? {};
  const bill = o.billing_address ?? {};
  const cust = o.customer ?? {};
  const tags = typeof o.tags === "string" ? o.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [];
  return {
    source: "rest",
    shopifyId: String(o.id),
    name: o.name ?? `#${o.order_number}`,
    orderNumber: o.order_number ?? null,
    shopCreatedAt: o.created_at,
    shopUpdatedAt: o.updated_at ?? o.created_at,
    cancelledAt: o.cancelled_at ?? null,
    cancelReason: o.cancel_reason ?? null,
    closedAt: o.closed_at ?? null,
    shopifyCustomerId: cust.id ? String(cust.id) : null,
    customerName: ship.name || joinName(ship.first_name, ship.last_name) || joinName(cust.first_name, cust.last_name) || bill.name || null,
    rawPhone: ship.phone || o.phone || cust.phone || bill.phone || null,
    email: o.email || o.contact_email || cust.email || null,
    address1: ship.address1 ?? null,
    address2: ship.address2 ?? null,
    city: ship.city ?? null,
    province: ship.province ?? null,
    zip: ship.zip ?? null,
    country: ship.country ?? null,
    currency: o.currency ?? "BDT",
    subtotal: toNumber(o.current_subtotal_price ?? o.subtotal_price),
    shippingTotal: toNumber(
      o.total_shipping_price_set?.shop_money?.amount ??
        (o.shipping_lines ?? []).reduce((s: number, l: { price: string }) => s + toNumber(l.price), 0),
    ),
    discountTotal: toNumber(o.current_total_discounts ?? o.total_discounts),
    total: toNumber(o.current_total_price ?? o.total_price),
    outstanding: toNumber(o.total_outstanding ?? (o.financial_status === "paid" ? 0 : o.total_price)),
    financialStatus: lower(o.financial_status),
    shopifyFulfillmentStatus: lower(o.fulfillment_status) ?? "unfulfilled",
    paymentGateways: o.payment_gateway_names ?? (o.gateway ? [o.gateway] : []),
    shippingMethod: o.shipping_lines?.[0]?.title ?? null,
    lineItems: (o.line_items ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (li: any): LineItem => ({
        id: String(li.id),
        title: li.title ?? li.name,
        variantTitle: li.variant_title ?? null,
        sku: li.sku ?? null,
        quantity: toNumber(li.current_quantity ?? li.quantity),
        fulfillableQuantity: li.fulfillable_quantity ?? null,
        price: toNumber(li.price),
        productId: li.product_id ? String(li.product_id) : null,
        variantId: li.variant_id ? String(li.variant_id) : null,
      }),
    ),
    shopifyTags: tags,
    shopifyNote: o.note ?? null,
    noteAttributes: (o.note_attributes ?? []).map((a: { name: string; value: unknown }) => ({ name: a.name, value: String(a.value ?? "") })),
    sourceName: o.source_name ?? null,
  };
}

const ORDER_FIELDS = /* GraphQL */ `
  id name number createdAt updatedAt cancelledAt cancelReason closedAt
  email phone note tags sourceName currencyCode
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames
  subtotalPriceSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalPriceSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  customAttributes { key value }
  shippingLine { title }
  customer { id displayName firstName lastName defaultPhoneNumber { phoneNumber } defaultEmailAddress { emailAddress } }
  shippingAddress { name firstName lastName address1 address2 city province zip country phone }
  billingAddress { name phone }
  lineItems(first: 100) {
    nodes {
      id title variantTitle sku quantity currentQuantity unfulfilledQuantity
      originalUnitPriceSet { shopMoney { amount } }
      product { id } variant { id }
    }
  }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeGraphqlOrder(o: any): NormalizedOrder {
  const ship = o.shippingAddress ?? {};
  const cust = o.customer ?? {};
  const money = (m: { shopMoney?: { amount?: string } } | null | undefined) => toNumber(m?.shopMoney?.amount);
  return {
    source: "graphql",
    shopifyId: gidToId(o.id)!,
    name: o.name,
    orderNumber: o.number ?? null,
    shopCreatedAt: o.createdAt,
    shopUpdatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt ?? null,
    cancelReason: lower(o.cancelReason),
    closedAt: o.closedAt ?? null,
    shopifyCustomerId: gidToId(cust.id),
    customerName: ship.name || joinName(ship.firstName, ship.lastName) || cust.displayName || o.billingAddress?.name || null,
    rawPhone: ship.phone || o.phone || cust.defaultPhoneNumber?.phoneNumber || o.billingAddress?.phone || null,
    email: o.email || cust.defaultEmailAddress?.emailAddress || null,
    address1: ship.address1 ?? null,
    address2: ship.address2 ?? null,
    city: ship.city ?? null,
    province: ship.province ?? null,
    zip: ship.zip ?? null,
    country: ship.country ?? null,
    currency: o.currencyCode ?? "BDT",
    subtotal: money(o.subtotalPriceSet),
    shippingTotal: money(o.totalShippingPriceSet),
    discountTotal: money(o.totalDiscountsSet),
    total: money(o.totalPriceSet),
    outstanding: money(o.totalOutstandingSet),
    financialStatus: lower(o.displayFinancialStatus),
    shopifyFulfillmentStatus: lower(o.displayFulfillmentStatus),
    paymentGateways: o.paymentGatewayNames ?? [],
    shippingMethod: o.shippingLine?.title ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lineItems: (o.lineItems?.nodes ?? []).map((li: any) => ({
      id: gidToId(li.id)!,
      title: li.title,
      variantTitle: li.variantTitle ?? null,
      sku: li.sku ?? null,
      quantity: li.currentQuantity ?? li.quantity,
      fulfillableQuantity: li.unfulfilledQuantity ?? null,
      price: money(li.originalUnitPriceSet),
      productId: gidToId(li.product?.id),
      variantId: gidToId(li.variant?.id),
    })),
    shopifyTags: o.tags ?? [],
    shopifyNote: o.note ?? null,
    noteAttributes: (o.customAttributes ?? []).map((a: { key: string; value: string }) => ({ name: a.key, value: a.value ?? "" })),
    sourceName: o.sourceName ?? null,
  };
}

/** One page of orders (newest first). `search` uses Shopify search syntax, e.g. `updated_at:>'2026-01-01T00:00:00Z'`. */
export async function fetchOrdersPage(env: Env, db: DB, opts: { after?: string | null; search?: string; first?: number; sortKey?: string; reverse?: boolean }) {
  const data = await shopifyGraphql<{
    orders: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  }>(
    env,
    db,
    `query Orders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
      orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
        nodes { ${ORDER_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { first: opts.first ?? 50, after: opts.after ?? null, query: opts.search ?? null, sortKey: opts.sortKey ?? "CREATED_AT", reverse: opts.reverse ?? true },
  );
  return { orders: data.orders.nodes.map(normalizeGraphqlOrder), pageInfo: data.orders.pageInfo };
}

export async function fetchOrder(env: Env, db: DB, shopifyId: string): Promise<NormalizedOrder | null> {
  const data = await shopifyGraphql<{ order: unknown | null }>(
    env,
    db,
    `query Order($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: `gid://shopify/Order/${shopifyId}` },
  );
  return data.order ? normalizeGraphqlOrder(data.order) : null;
}

// ---------------------------------------------------------------------------
// Fulfillment

export type FulfillmentOrderInfo = {
  id: string;
  status: string; // OPEN | IN_PROGRESS | ON_HOLD | SCHEDULED | CLOSED | CANCELLED | INCOMPLETE
  canFulfill: boolean;
  location: string | null;
  lineItems: { id: string; lineItemId: string; remainingQuantity: number }[];
};

export async function getFulfillmentOrders(env: Env, db: DB, shopifyOrderId: string) {
  const data = await shopifyGraphql<{
    order: {
      id: string;
      displayFulfillmentStatus: string;
      cancelledAt: string | null;
      fulfillmentOrders: {
        nodes: {
          id: string;
          status: string;
          assignedLocation: { name: string } | null;
          supportedActions: { action: string }[];
          lineItems: { nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[] };
        }[];
      };
    } | null;
  }>(
    env,
    db,
    `query FulfillmentOrders($id: ID!) {
      order(id: $id) {
        id displayFulfillmentStatus cancelledAt
        fulfillmentOrders(first: 20) {
          nodes {
            id status
            assignedLocation { name }
            supportedActions { action }
            lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } }
          }
        }
      }
    }`,
    { id: `gid://shopify/Order/${shopifyOrderId}` },
  );
  if (!data.order) return null;
  return {
    fulfillmentStatus: data.order.displayFulfillmentStatus,
    cancelledAt: data.order.cancelledAt,
    fulfillmentOrders: data.order.fulfillmentOrders.nodes.map(
      (fo): FulfillmentOrderInfo => ({
        id: fo.id,
        status: fo.status,
        canFulfill: fo.supportedActions.some((a) => a.action === "CREATE_FULFILLMENT"),
        location: fo.assignedLocation?.name ?? null,
        lineItems: fo.lineItems.nodes.map((li) => ({ id: li.id, lineItemId: gidToId(li.lineItem.id)!, remainingQuantity: li.remainingQuantity })),
      }),
    ),
  };
}

export async function createFulfillment(
  env: Env,
  db: DB,
  input: {
    fulfillmentOrderId: string;
    lineItems?: { id: string; quantity: number }[];
    tracking: { company: string; number: string; url: string };
    notifyCustomer: boolean;
  },
) {
  const data = await shopifyGraphql<{
    fulfillmentCreate: { fulfillment: { id: string; status: string } | null; userErrors: { field: string[] | null; message: string }[] };
  }>(
    env,
    db,
    `mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: input.fulfillmentOrderId,
            ...(input.lineItems ? { fulfillmentOrderLineItems: input.lineItems } : {}),
          },
        ],
        trackingInfo: input.tracking,
        notifyCustomer: input.notifyCustomer,
      },
    },
  );
  const r = data.fulfillmentCreate;
  if (r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
  return r.fulfillment!;
}

export async function addOrderTags(env: Env, db: DB, shopifyOrderId: string, tags: string[]) {
  const data = await shopifyGraphql<{ tagsAdd: { userErrors: { message: string }[] } }>(
    env,
    db,
    `mutation TagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
    { id: `gid://shopify/Order/${shopifyOrderId}`, tags },
  );
  if (data.tagsAdd.userErrors.length) throw new Error(data.tagsAdd.userErrors.map((e) => e.message).join("; "));
}

// ---------------------------------------------------------------------------
// Connection & webhooks

export async function getShopInfo(env: Env, db: DB) {
  const data = await shopifyGraphql<{ shop: { name: string; myshopifyDomain: string; currencyCode: string; ianaTimezone: string } }>(
    env,
    db,
    `{ shop { name myshopifyDomain currencyCode ianaTimezone } }`,
  );
  return data.shop;
}

export const WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "ORDERS_DELETE"] as const;

export async function listWebhookSubscriptions(env: Env, db: DB) {
  const data = await shopifyGraphql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] } }>(
    env,
    db,
    `{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`,
  );
  return data.webhookSubscriptions.nodes;
}

export async function registerWebhooks(env: Env, db: DB, callbackUrl: string) {
  const existing = await listWebhookSubscriptions(env, db);
  const results: { topic: string; status: "exists" | "created" | "error"; message?: string }[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (existing.some((w) => w.topic === topic && w.uri === callbackUrl)) {
      results.push({ topic, status: "exists" });
      continue;
    }
    const data = await shopifyGraphql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(
      env,
      db,
      `mutation Create($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { message } }
      }`,
      { topic, sub: { uri: callbackUrl } },
    );
    const errs = data.webhookSubscriptionCreate.userErrors;
    results.push(errs.length ? { topic, status: "error", message: errs.map((e) => e.message).join("; ") } : { topic, status: "created" });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Order processing state & cancellation

/**
 * Marks the order "In progress" in Shopify the native way: reports progress on each open
 * fulfillment order (fulfillmentOrderReportProgress), which Shopify shows as fulfillment status
 * "In progress". Already in-progress fulfillment orders are left alone.
 */
export async function markOrderInProgress(env: Env, db: DB, shopifyOrderId: string, reasonNotes: string) {
  const info = await getFulfillmentOrders(env, db, shopifyOrderId);
  if (!info) throw new Error("Order not found in Shopify");
  const open = info.fulfillmentOrders.filter((fo) => fo.status === "OPEN" && fo.lineItems.some((li) => li.remainingQuantity > 0));
  for (const fo of open) {
    const data = await shopifyGraphql<{ fulfillmentOrderReportProgress: { fulfillmentOrder: { id: string; status: string } | null; userErrors: { message: string }[] } }>(
      env,
      db,
      `mutation ReportProgress($id: ID!, $progressReport: FulfillmentOrderReportProgressInput) {
        fulfillmentOrderReportProgress(id: $id, progressReport: $progressReport) {
          fulfillmentOrder { id status }
          userErrors { message }
        }
      }`,
      { id: fo.id, progressReport: { reasonNotes } },
    );
    const errs = data.fulfillmentOrderReportProgress.userErrors;
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
  return { updated: open.length, alreadyInProgress: info.fulfillmentOrders.filter((fo) => fo.status === "IN_PROGRESS").length };
}

/** Reverts "In progress" back to open (fulfillmentOrderOpen) when a confirmation is withdrawn. */
export async function reopenOrder(env: Env, db: DB, shopifyOrderId: string) {
  const info = await getFulfillmentOrders(env, db, shopifyOrderId);
  if (!info) throw new Error("Order not found in Shopify");
  const inProgress = info.fulfillmentOrders.filter((fo) => fo.status === "IN_PROGRESS");
  for (const fo of inProgress) {
    const data = await shopifyGraphql<{ fulfillmentOrderOpen: { userErrors: { message: string }[] } }>(
      env,
      db,
      `mutation Open($id: ID!) { fulfillmentOrderOpen(id: $id) { fulfillmentOrder { id status } userErrors { message } } }`,
      { id: fo.id },
    );
    const errs = data.fulfillmentOrderOpen.userErrors;
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
  return { reopened: inProgress.length };
}

export const CANCEL_REASONS = ["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"] as const;

/** orderCancel runs asynchronously in Shopify; the orders/cancelled webhook confirms completion. */
export async function cancelOrder(
  env: Env,
  db: DB,
  shopifyOrderId: string,
  opts: { reason: (typeof CANCEL_REASONS)[number]; restock: boolean; notifyCustomer: boolean; staffNote?: string },
) {
  const data = await shopifyGraphql<{
    orderCancel: { job: { id: string; done: boolean } | null; orderCancelUserErrors: { code: string | null; message: string }[] };
  }>(
    env,
    db,
    `mutation Cancel($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String, $refundMethod: OrderCancelRefundMethodInput) {
      orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote, refundMethod: $refundMethod) {
        job { id done }
        orderCancelUserErrors { code message }
      }
    }`,
    {
      orderId: `gid://shopify/Order/${shopifyOrderId}`,
      reason: opts.reason,
      restock: opts.restock,
      notifyCustomer: opts.notifyCustomer,
      staffNote: opts.staffNote?.slice(0, 255),
      // Never refund automatically; refunds are a separate, explicit decision in Shopify.
      refundMethod: { originalPaymentMethodsRefund: false },
    },
  );
  const errs = data.orderCancel.orderCancelUserErrors;
  if (errs.length) throw new HttpError(422, errs.map((e) => e.message).join("; "));
  return data.orderCancel.job;
}

/** Deletes an order where Shopify allows it; returns the Shopify error message otherwise. */
export async function deleteOrder(env: Env, db: DB, shopifyOrderId: string): Promise<{ deleted: boolean; error?: string }> {
  const data = await shopifyGraphql<{ orderDelete: { deletedId: string | null; userErrors: { message: string }[] } }>(
    env,
    db,
    `mutation Delete($orderId: ID!) { orderDelete(orderId: $orderId) { deletedId userErrors { message } } }`,
    { orderId: `gid://shopify/Order/${shopifyOrderId}` },
  );
  const errs = data.orderDelete.userErrors;
  return errs.length ? { deleted: false, error: errs.map((e) => e.message).join("; ") } : { deleted: Boolean(data.orderDelete.deletedId) };
}

/** Closes the order, which Shopify admin shows as "Archived". */
export async function closeOrder(env: Env, db: DB, shopifyOrderId: string) {
  const data = await shopifyGraphql<{ orderClose: { userErrors: { message: string }[] } }>(
    env,
    db,
    `mutation Close($input: OrderCloseInput!) { orderClose(input: $input) { order { id closedAt } userErrors { message } } }`,
    { input: { id: `gid://shopify/Order/${shopifyOrderId}` } },
  );
  const errs = data.orderClose.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
}
