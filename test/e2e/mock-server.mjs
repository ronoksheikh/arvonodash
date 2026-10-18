// Local mock of the Shopify Admin API and Steadfast API for end-to-end testing.
// Responses follow the documented shapes. State is inspectable at GET /__state.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8790);
const state = { fulfillments: [], tags: [], consignments: [], tokenRequests: 0, webhooks: [], returnRequests: [], progressReports: [], reopened: [], cancelled: [], deleteAttempts: [], closed: [] };
const restOrders = {}; // shopify id -> REST payload registered by the test (mirrors webhook data)

function displayStatus(orderId) {
  const fos = fulfillmentOrders[orderId];
  if (!fos) return "UNFULFILLED";
  if (fos.every((f) => f.status === "CLOSED")) return "FULFILLED";
  if (fos.some((f) => f.status === "IN_PROGRESS")) return "IN_PROGRESS";
  return "UNFULFILLED";
}

function restToGql(o) {
  const m = (v) => ({ shopMoney: { amount: String(v ?? "0") } });
  const sa = o.shipping_address ?? {};
  return {
    id: `gid://shopify/Order/${o.id}`, name: o.name, number: o.order_number, createdAt: o.created_at, updatedAt: o.updated_at,
    cancelledAt: state.cancelled.find((c) => c.id === String(o.id))?.at ?? o.cancelled_at ?? null, cancelReason: null, closedAt: null,
    email: o.email ?? null, phone: o.phone ?? null, note: o.note ?? null, tags: [], sourceName: "web", currencyCode: "BDT",
    displayFinancialStatus: "PENDING", displayFulfillmentStatus: displayStatus(String(o.id)), paymentGatewayNames: o.payment_gateway_names ?? [],
    subtotalPriceSet: m(o.subtotal_price), totalShippingPriceSet: m(120), totalDiscountsSet: m(0), totalPriceSet: m(o.total_price), totalOutstandingSet: m(o.total_outstanding),
    customAttributes: [], shippingLine: { title: "Inside Dhaka" },
    customer: { id: `gid://shopify/Customer/${o.customer?.id ?? 1}`, displayName: "x", firstName: null, lastName: null, defaultPhoneNumber: null, defaultEmailAddress: null },
    shippingAddress: { name: sa.name, firstName: null, lastName: null, address1: sa.address1, address2: sa.address2 ?? null, city: sa.city, province: null, zip: sa.zip, country: sa.country, phone: sa.phone },
    billingAddress: null,
    lineItems: { nodes: o.line_items.map((li) => ({ id: `gid://shopify/LineItem/${li.id}`, title: li.title, variantTitle: li.variant_title, sku: li.sku, quantity: li.quantity, currentQuantity: li.quantity, unfulfilledQuantity: li.quantity, originalUnitPriceSet: m(li.price), product: null, variant: { id: `gid://shopify/ProductVariant/${li.variant_id}` } })) },
  };
}
let nextCid = 1424100;

const shopifyOrders = [1, 2, 3].map((n) => ({
  id: `gid://shopify/Order/${7000 + n}`,
  name: `#90${n}`,
  number: 900 + n,
  createdAt: new Date(Date.now() - n * 86_400_000).toISOString(),
  updatedAt: new Date(Date.now() - n * 3_600_000).toISOString(),
  cancelledAt: null, cancelReason: null, closedAt: null,
  email: `c${n}@example.com`, phone: null, note: n === 1 ? "Please call first" : null, tags: ["imported"], sourceName: "web", currencyCode: "BDT",
  displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", paymentGatewayNames: ["Cash on Delivery (COD)"],
  subtotalPriceSet: { shopMoney: { amount: "1000.0" } }, totalShippingPriceSet: { shopMoney: { amount: "60.0" } },
  totalDiscountsSet: { shopMoney: { amount: "0.0" } }, totalPriceSet: { shopMoney: { amount: "1060.0" } }, totalOutstandingSet: { shopMoney: { amount: "1060.0" } },
  customAttributes: [], shippingLine: { title: "Inside Dhaka" },
  customer: { id: `gid://shopify/Customer/${300 + n}`, displayName: `Imported ${n}`, firstName: "Imported", lastName: String(n), defaultPhoneNumber: { phoneNumber: `+8801711000${100 + n}` }, defaultEmailAddress: { emailAddress: `c${n}@example.com` } },
  shippingAddress: { name: `Imported Customer ${n}`, firstName: "Imported", lastName: String(n), address1: `House ${n}, Road 7, Dhanmondi`, address2: null, city: "Dhaka", province: null, zip: "1209", country: "Bangladesh", phone: `01711000${100 + n}` },
  billingAddress: null,
  lineItems: { nodes: [{ id: `gid://shopify/LineItem/${80000 + n}`, title: "Panjabi", variantTitle: "M", sku: "PJ-M", quantity: 1, currentQuantity: 1, unfulfilledQuantity: 1, originalUnitPriceSet: { shopMoney: { amount: "1000.0" } }, product: { id: "gid://shopify/Product/1" }, variant: { id: "gid://shopify/ProductVariant/2" } }] },
}));

// Fulfillment orders per Shopify order id (numeric)
const fulfillmentOrders = {};
function foFor(orderId) {
  if (!fulfillmentOrders[orderId]) {
    fulfillmentOrders[orderId] = [{
      id: `gid://shopify/FulfillmentOrder/${orderId}1`,
      status: "OPEN",
      assignedLocation: { name: "Dhaka Warehouse" },
      supportedActions: [{ action: "CREATE_FULFILLMENT" }],
      lineItems: { nodes: [
        { id: `gid://shopify/FulfillmentOrderLineItem/${orderId}01`, remainingQuantity: 2, lineItem: { id: "gid://shopify/LineItem/9001" } },
        { id: `gid://shopify/FulfillmentOrderLineItem/${orderId}02`, remainingQuantity: 1, lineItem: { id: "gid://shopify/LineItem/9002" } },
      ] },
    }];
  }
  return fulfillmentOrders[orderId];
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function graphql(query, variables) {
  if (query.includes("FulfillmentOrders")) {
    const id = variables.id.split("/").pop();
    return { data: { order: { id: variables.id, displayFulfillmentStatus: displayStatus(id), cancelledAt: state.cancelled.find((c) => c.id === id)?.at ?? null, fulfillmentOrders: { nodes: foFor(id) } } } };
  }
  if (query.includes("fulfillmentCreate")) {
    const input = variables.fulfillment;
    state.fulfillments.push(input);
    for (const group of input.lineItemsByFulfillmentOrder) {
      for (const fos of Object.values(fulfillmentOrders)) {
        const fo = fos.find((f) => f.id === group.fulfillmentOrderId);
        if (!fo) continue;
        for (const li of fo.lineItems.nodes) {
          const req = group.fulfillmentOrderLineItems?.find((x) => x.id === li.id);
          li.remainingQuantity -= req ? req.quantity : li.remainingQuantity;
        }
        if (fo.lineItems.nodes.every((li) => li.remainingQuantity === 0)) fo.status = "CLOSED";
      }
    }
    return { data: { fulfillmentCreate: { fulfillment: { id: `gid://shopify/Fulfillment/${state.fulfillments.length}`, status: "SUCCESS" }, userErrors: [] } } };
  }
  if (query.includes("fulfillmentOrderReportProgress")) {
    for (const fos of Object.values(fulfillmentOrders)) for (const fo of fos) if (fo.id === variables.id) fo.status = "IN_PROGRESS";
    state.progressReports.push(variables);
    return { data: { fulfillmentOrderReportProgress: { fulfillmentOrder: { id: variables.id, status: "IN_PROGRESS" }, userErrors: [] } } };
  }
  if (query.includes("fulfillmentOrderOpen")) {
    for (const fos of Object.values(fulfillmentOrders)) for (const fo of fos) if (fo.id === variables.id) fo.status = "OPEN";
    state.reopened.push(variables.id);
    return { data: { fulfillmentOrderOpen: { fulfillmentOrder: { id: variables.id, status: "OPEN" }, userErrors: [] } } };
  }
  if (query.includes("orderCancel")) {
    const id = variables.orderId.split("/").pop();
    state.cancelled.push({ id, at: new Date().toISOString(), reason: variables.reason, restock: variables.restock, refundMethod: variables.refundMethod });
    if (restOrders[id]) restOrders[id].updated_at = new Date().toISOString();
    return { data: { orderCancel: { job: { id: "gid://shopify/Job/1", done: false }, orderCancelUserErrors: [] } } };
  }
  if (query.includes("orderDelete")) {
    state.deleteAttempts.push(variables.orderId);
    return { data: { orderDelete: { deletedId: null, userErrors: [{ message: "Order can't be deleted because it isn't archived or cancelled" }] } } };
  }
  if (query.includes("orderClose")) {
    state.closed.push(variables.input.id);
    return { data: { orderClose: { order: { id: variables.input.id, closedAt: new Date().toISOString() }, userErrors: [] } } };
  }
  if (query.includes("tagsAdd")) {
    state.tags.push(variables);
    return { data: { tagsAdd: { userErrors: [] } } };
  }
  if (query.includes("query Orders")) {
    const after = variables.after ? Number(variables.after) : 0;
    const page = shopifyOrders.slice(after, after + 2);
    return { data: { orders: { nodes: page, pageInfo: { hasNextPage: after + 2 < shopifyOrders.length, endCursor: String(after + 2) } } }, extensions: { cost: { requestedQueryCost: 50, throttleStatus: { currentlyAvailable: 1900, restoreRate: 100, maximumAvailable: 2000 } } } };
  }
  if (query.includes("query Order(")) {
    const id = variables.id.split("/").pop();
    if (restOrders[id]) return { data: { order: restToGql(restOrders[id]) } };
    return { data: { order: shopifyOrders.find((o) => o.id === variables.id) ?? null } };
  }
  if (query.includes("shop {")) return { data: { shop: { name: "ARVONO Test", myshopifyDomain: "arvono-test.myshopify.com", currencyCode: "BDT", ianaTimezone: "Asia/Dhaka" } } };
  if (query.includes("webhookSubscriptions")) return { data: { webhookSubscriptions: { nodes: state.webhooks } } };
  if (query.includes("webhookSubscriptionCreate")) {
    state.webhooks.push({ id: `gid://shopify/WebhookSubscription/${state.webhooks.length + 1}`, topic: variables.topic, uri: variables.sub.uri });
    return { data: { webhookSubscriptionCreate: { webhookSubscription: { id: "x" }, userErrors: [] } } };
  }
  return { errors: [{ message: "Unknown query in mock" }] };
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/__state") return json(res, 200, state);
  if (p === "/__orders" && req.method === "POST") {
    const o = JSON.parse(body);
    restOrders[String(o.id)] = o;
    return json(res, 200, { ok: true });
  }
  if (p === "/__fo_status" && req.method === "POST") {
    // Simulates staff changing fulfillment status in Shopify admin / mobile app.
    const { orderId, status } = JSON.parse(body);
    for (const fo of foFor(String(orderId))) fo.status = status;
    if (restOrders[orderId]) restOrders[orderId].updated_at = new Date().toISOString();
    return json(res, 200, { ok: true });
  }

  // Shopify
  if (p === "/admin/oauth/access_token") {
    state.tokenRequests++;
    const params = new URLSearchParams(body);
    if (params.get("grant_type") !== "client_credentials") return json(res, 400, { error: "bad grant" });
    return json(res, 200, { access_token: "mock-token", scope: "read_orders", expires_in: 86399 });
  }
  if (p.startsWith("/admin/api/") && p.endsWith("/graphql.json")) {
    if (req.headers["x-shopify-access-token"] !== "mock-token") return json(res, 401, { errors: "Invalid API key or access token" });
    const { query, variables } = JSON.parse(body);
    return json(res, 200, graphql(query, variables ?? {}));
  }

  // Steadfast
  if (p.startsWith("/api/v1/")) {
    if (req.headers["api-key"] !== "sf-key" || req.headers["secret-key"] !== "sf-secret") return json(res, 401, { message: "Unauthorized" });
    const route = p.slice("/api/v1".length);
    if (route === "/create_order" && req.method === "POST") {
      const input = JSON.parse(body);
      if (!/^01[3-9]\d{8}$/.test(input.recipient_phone)) return json(res, 422, { status: 400, errors: { recipient_phone: ["The recipient phone must be 11 digits."] } });
      if (state.consignments.some((c) => c.invoice === input.invoice)) return json(res, 422, { status: 400, errors: { invoice: ["The invoice has already been taken."] } });
      const c = { consignment_id: nextCid++, invoice: input.invoice, tracking_code: `TRK${nextCid}`, status: "in_review", ...input };
      state.consignments.push(c);
      return json(res, 200, { status: 200, message: "Consignment has been created successfully.", consignment: { ...c, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    }
    let m;
    if ((m = route.match(/^\/status_by_cid\/(\d+)$/))) {
      const c = state.consignments.find((x) => String(x.consignment_id) === m[1]);
      return c ? json(res, 200, { status: 200, delivery_status: c.status }) : json(res, 404, { status: 404, message: "Not found" });
    }
    if ((m = route.match(/^\/status_by_invoice\/(.+)$/))) {
      const c = state.consignments.find((x) => x.invoice === decodeURIComponent(m[1]));
      return c ? json(res, 200, { status: 200, delivery_status: c.status }) : json(res, 404, { status: 404, message: "Consignment not found" });
    }
    if (route === "/get_balance") return json(res, 200, { status: 200, current_balance: 15230.5 });
    if (route === "/create_return_request") {
      const input = JSON.parse(body);
      const rr = { id: state.returnRequests.length + 1, user_id: 1, consignment_id: input.consignment_id, reason: input.reason ?? null, status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      state.returnRequests.push(rr);
      return json(res, 200, rr);
    }
    if ((m = route.match(/^\/get_return_request\/(\d+)$/))) return json(res, 200, { ...state.returnRequests[Number(m[1]) - 1], status: "approved" });
    if (route === "/payments") {
      const delivered = state.consignments.filter((c) => c.status === "delivered");
      return json(res, 200, url.searchParams.get("page") === "1" && delivered.length ? { data: [{ id: 501, amount: 1000, status: "paid", paid_at: new Date().toISOString() }] } : { data: [] });
    }
    if ((m = route.match(/^\/payments\/(\d+)$/))) {
      return json(res, 200, { data: { id: Number(m[1]), consignments: state.consignments.filter((c) => c.status === "delivered").map((c) => ({ consignment_id: c.consignment_id, invoice: c.invoice })) } });
    }
    // Test helper: set a consignment's status (simulates courier progress for polling)
    if (route === "/__set_status") {
      const { consignment_id, status } = JSON.parse(body);
      const c = state.consignments.find((x) => x.consignment_id === consignment_id);
      if (c) c.status = status;
      return json(res, 200, { ok: Boolean(c) });
    }
  }
  json(res, 404, { error: `mock: no route ${req.method} ${p}` });
});

server.listen(PORT, () => console.log(`mock server on :${PORT}`));
