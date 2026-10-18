// End-to-end test against a running dev server (npm run dev) wired to test/e2e/mock-server.mjs.
// Usage: BASE=http://localhost:5173 MOCK=http://localhost:8790 node test/e2e/run.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:5173";
const MOCK = process.env.MOCK ?? "http://localhost:8790";
const SHOPIFY_SECRET = "shopify-secret";
const SF_TOKEN = "sf-webhook-token";
let cookie = "";
let passed = 0;

async function call(method, path, body, { auth = true, headers = {}, raw = false, jar = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "X-Requested-With": "arvono", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && jar) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let parsed = text;
  if (!raw) {
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n`, err);
    process.exit(1);
  }
};

function shopifyWebhook(topic, payload, id = crypto.randomUUID(), secret = SHOPIFY_SECRET) {
  const raw = JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return call("POST", "/webhooks/shopify", raw, {
    auth: false,
    headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": hmac, "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": id, "X-Shopify-Shop-Domain": "arvono-test.myshopify.com" },
  });
}

const steadfastWebhook = (payload, token = SF_TOKEN) =>
  call("POST", "/webhooks/steadfast", payload, { auth: false, headers: { Authorization: `Bearer ${token}` } });

const mockState = () => fetch(`${MOCK}/__state`).then((r) => r.json());
const setCourierStatus = (consignment_id, status) =>
  fetch(`${MOCK}/api/v1/__set_status`, { method: "POST", headers: { "Api-Key": "sf-key", "Secret-Key": "sf-secret", "Content-Type": "application/json" }, body: JSON.stringify({ consignment_id, status }) });

const restOrder = (id, overrides = {}) => ({
  id, name: `#${id}`, order_number: id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  financial_status: "pending", fulfillment_status: null, total_price: "1250.00", subtotal_price: "1130.00", total_outstanding: "1250.00",
  total_discounts: "0.00", currency: "BDT", tags: "", payment_gateway_names: ["Cash on Delivery (COD)"], email: "karim@example.com",
  shipping_lines: [{ title: "Inside Dhaka", price: "120.00" }],
  customer: { id: 4242, first_name: "Karim", last_name: "Uddin" },
  shipping_address: { name: "Karim Uddin", address1: "House 12, Road 5, Dhanmondi", city: "Dhaka", zip: "1209", country: "Bangladesh", phone: "+880 1812-345678" },
  line_items: [
    { id: 9001, title: "Cotton Panjabi", variant_title: "L", sku: "PJ-L", quantity: 2, price: "450.00", variant_id: 77 },
    { id: 9002, title: "Attar 6ml", variant_title: null, sku: "AT-6", quantity: 1, price: "230.00", variant_id: 78 },
  ],
  ...overrides,
});

console.log(`E2E against ${BASE}`);

let orderA, orderB, consignmentA, consignmentB;

await step("first-run setup creates owner", async () => {
  const s = await call("GET", "/api/auth/setup-status", undefined, { auth: false });
  assert.equal(s.body.needsSetup, true);
  const r = await call("POST", "/api/auth/setup", { name: "Owner", email: "owner@arvono.test", password: "very-secret-pass" });
  assert.equal(r.status, 200);
  const again = await call("POST", "/api/auth/setup", { name: "X", email: "x@arvono.test", password: "very-secret-pass" }, { jar: false });
  assert.equal(again.status, 409);
  const me = await call("GET", "/api/auth/me");
  assert.equal(me.body.user.role, "owner");
});

await step("API rejects missing CSRF header and anonymous access", async () => {
  const r = await fetch(`${BASE}/api/orders/bulk`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 403);
  const anon = await call("GET", "/api/orders", undefined, { auth: false });
  assert.equal(anon.status, 401);
});

await step("Shopify webhook rejects bad HMAC", async () => {
  const r = await shopifyWebhook("orders/create", restOrder(5001), undefined, "wrong-secret");
  assert.equal(r.status, 401);
});

await step("Shopify orders/create webhook creates order (idempotent)", async () => {
  const id = crypto.randomUUID();
  const r = await shopifyWebhook("orders/create", restOrder(5001), id);
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "processed");
  const dup = await shopifyWebhook("orders/create", restOrder(5001), id);
  assert.equal(dup.body.result, "duplicate");
  const list = await call("GET", "/api/orders");
  assert.equal(list.body.total, 1);
  orderA = list.body.rows[0];
  assert.equal(orderA.phone, "01812345678");
  assert.equal(orderA.courierStage, "unbooked");
  assert.equal(orderA.statusId !== null, true, "default status assigned");
});

await step("second order from same phone is flagged as duplicate", async () => {
  await shopifyWebhook("orders/create", restOrder(5002));
  const list = await call("GET", "/api/orders?tab=attention");
  const b = list.body.rows.find((r) => r.name === "#5002");
  assert.ok(b, "flagged order in attention tab");
  assert.ok(b.riskFlags.includes("duplicate_recent"));
  assert.ok(b.riskFlags.includes("duplicate_items"));
  orderB = b;
});

await step("stale orders/updated webhook is ignored", async () => {
  const r = await shopifyWebhook("orders/updated", restOrder(5001, { updated_at: "2020-01-01T00:00:00Z", note: "old" }));
  assert.equal(r.body.result, "ignored");
});

await step("order detail includes booking defaults", async () => {
  const d = await call("GET", `/api/orders/${orderA.id}`);
  assert.equal(d.body.booking.recipientPhone, "01812345678");
  assert.equal(d.body.booking.codAmount, 1250);
  assert.match(d.body.booking.recipientAddress, /Dhanmondi/);
  assert.equal(d.body.otherOrders.length, 1);
});

await step("booking edits are validated and saved (partial shipment)", async () => {
  const bad = await call("PUT", `/api/orders/${orderA.id}/booking`, { booking: { recipientPhone: "12345" } });
  assert.equal(bad.status, 400);
  const ok = await call("PUT", `/api/orders/${orderA.id}/booking`, { booking: { codAmount: 900, note: "Call before delivery", lineItems: [{ lineItemId: "9001", quantity: 1 }] } });
  assert.equal(ok.status, 200);
  const d = await call("GET", `/api/orders/${orderA.id}`);
  assert.equal(d.body.booking.codAmount, 900);
});

await step("orders are never booked automatically", async () => {
  const s = await mockState();
  assert.equal(s.consignments.length, 0);
});

await step("manual booking creates consignment; duplicate booking refused", async () => {
  const r = await call("POST", "/api/orders/book", { ids: [orderA.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].ok, true, JSON.stringify(r.body));
  const again = await call("POST", "/api/orders/book", { ids: [orderA.id] });
  assert.equal(again.body.results[0].ok, false);
  assert.match(again.body.results[0].error, /already has an active consignment/);
  const s = await mockState();
  assert.equal(s.consignments.length, 1);
  assert.equal(s.consignments[0].invoice, "5001");
  assert.equal(s.consignments[0].cod_amount, 900);
  assert.equal(s.consignments[0].recipient_phone, "01812345678");
  const d = await call("GET", `/api/orders/${orderA.id}`);
  consignmentA = d.body.consignments[0];
  assert.equal(d.body.order.courierStage, "booked");
  assert.equal(d.body.order.fulfillmentState, "none", "not fulfilled on booking with default trigger");
});

await step("Steadfast webhook rejects wrong bearer token", async () => {
  const r = await steadfastWebhook({ consignment_id: Number(consignmentA.consignmentId), status: "pending" }, "nope");
  assert.equal(r.status, 401);
});

await step("pickup webhook triggers Shopify fulfillment with tracking (partial items)", async () => {
  const r = await steadfastWebhook({ notification_type: "delivery_status", consignment_id: Number(consignmentA.consignmentId), invoice: consignmentA.invoice, status: "pending", cod_amount: 900, tracking_message: "Parcel picked up", updated_at: new Date().toISOString() });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "success");
  await new Promise((res) => setTimeout(res, 800));
  const s = await mockState();
  assert.equal(s.fulfillments.length, 1);
  const f = s.fulfillments[0];
  assert.equal(f.trackingInfo.number, consignmentA.trackingCode);
  assert.match(f.trackingInfo.url, /steadfast/);
  assert.deepEqual(f.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems, [{ id: "gid://shopify/FulfillmentOrderLineItem/500101", quantity: 1 }]);
  const d = await call("GET", `/api/orders/${orderA.id}`);
  assert.equal(d.body.order.fulfillmentState, "fulfilled");
  assert.equal(d.body.order.courierStage, "in_transit");
  assert.ok(s.tags.some((t) => t.tags.includes("steadfast-booked")), "booked tag job ran");
});

await step("repeated webhook and manual fulfill do not double-fulfill", async () => {
  await steadfastWebhook({ notification_type: "delivery_status", consignment_id: Number(consignmentA.consignmentId), status: "pending", updated_at: new Date().toISOString() });
  const f = await call("POST", `/api/orders/${orderA.id}/fulfill`);
  assert.equal(f.body.fulfillmentState, "fulfilled");
  const s = await mockState();
  assert.equal(s.fulfillments.length, 1);
});

await step("tracking_update adds timeline entry", async () => {
  await steadfastWebhook({ notification_type: "tracking_update", consignment_id: Number(consignmentA.consignmentId), invoice: consignmentA.invoice, tracking_message: "Reached Dhanmondi hub", updated_at: new Date().toISOString() });
  const d = await call("GET", `/api/orders/${orderA.id}`);
  assert.ok(d.body.events.some((e) => e.message === "Reached Dhanmondi hub"));
});

await step("delivered webhook records collected COD and delivery charge", async () => {
  await setCourierStatus(Number(consignmentA.consignmentId), "delivered");
  await steadfastWebhook({ notification_type: "delivery_status", consignment_id: Number(consignmentA.consignmentId), invoice: consignmentA.invoice, status: "delivered", cod_amount: 900, delivery_charge: 60, tracking_message: "Delivered", updated_at: new Date().toISOString() });
  const d = await call("GET", `/api/orders/${orderA.id}`);
  const c = d.body.consignments[0];
  assert.equal(c.stage, "delivered");
  assert.equal(c.collectedAmount, 900);
  assert.equal(c.deliveryCharge, 60);
  assert.equal(d.body.order.courierStage, "delivered");
});

await step("COD settlement sync links consignment to payment", async () => {
  const r = await call("POST", "/api/sync/payments");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.linkedConsignments, 1);
  const cod = await call("GET", "/api/cod");
  assert.equal(cod.body.summary.settled, 900);
  assert.equal(cod.body.payments.length, 1);
});

await step("unknown consignment webhook is stored as failed and acknowledged", async () => {
  const r = await steadfastWebhook({ consignment_id: 99999, status: "pending", updated_at: new Date().toISOString() });
  assert.equal(r.status, 200);
  const s = await call("GET", "/api/logs/sync?webhookStatus=failed");
  assert.ok(s.body.events.some((e) => e.provider === "steadfast"));
});

await step("blocked status prevents booking; flagged order books after status change", async () => {
  const settings = await call("GET", "/api/settings");
  const hold = settings.body.statuses.find((s) => s.blocksBooking);
  await call("PATCH", `/api/orders/${orderB.id}`, { statusId: hold.id });
  const r = await call("POST", "/api/orders/book", { ids: [orderB.id] });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /blocks booking/);
  const confirmed = settings.body.statuses.find((s) => s.name === "Confirmed");
  await call("PATCH", `/api/orders/${orderB.id}`, { statusId: confirmed.id });
  const ok = await call("POST", "/api/orders/book", { ids: [orderB.id] });
  assert.equal(ok.body.results[0].ok, true, JSON.stringify(ok.body));
  const d = await call("GET", `/api/orders/${orderB.id}`);
  consignmentB = d.body.consignments[0];
});

await step("cron-style polling picks up status changes (missed webhooks)", async () => {
  await setCourierStatus(Number(consignmentB.consignmentId), "pending");
  const r = await call("POST", "/api/sync/courier");
  assert.equal(r.status, 200);
  assert.ok(r.body.changed >= 1, JSON.stringify(r.body));
  await call("POST", "/api/sync/jobs/run");
  const s = await mockState();
  assert.equal(s.fulfillments.length, 2, "order B fulfilled after pickup detected by polling");
});

await step("return after pickup creates return record; no auto refund/restock", async () => {
  await setCourierStatus(Number(consignmentB.consignmentId), "cancelled");
  const r = await call("POST", "/api/consignments/refresh", { ids: [consignmentB.id] });
  assert.equal(r.body.changed, 1);
  const d = await call("GET", `/api/orders/${orderB.id}`);
  assert.equal(d.body.order.courierStage, "returned");
  assert.equal(d.body.returns.length, 1);
  assert.equal(d.body.returns[0].type, "courier_return");
  assert.equal(d.body.returns[0].refundConfirmed, false);
  const upd = await call("PATCH", `/api/returns/${d.body.returns[0].id}`, { status: "received", condition: "good", restockConfirmed: true });
  assert.equal(upd.status, 200);
});

await step("release + rebook (redelivery) uses a new invoice", async () => {
  const rel = await call("POST", `/api/consignments/${consignmentB.id}/release`);
  assert.equal(rel.status, 200);
  const ok = await call("POST", "/api/orders/book", { ids: [orderB.id] });
  assert.equal(ok.body.results[0].ok, true, JSON.stringify(ok.body));
  const s = await mockState();
  assert.ok(s.consignments.some((c) => c.invoice === "5002-R1"));
});

await step("Steadfast return request for delivered parcel", async () => {
  const r = await call("POST", `/api/consignments/${consignmentA.id}/return-request`, { reason: "Wrong size" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await call("POST", `/api/consignments/${consignmentA.id}/return-request`, { reason: "again" });
  assert.equal(again.status, 409);
});

await step("historical import pulls Shopify orders via GraphQL", async () => {
  const r = await call("POST", "/api/sync/import/start", { sinceDays: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.step.done, true);
  const list = await call("GET", "/api/orders?search=Imported");
  assert.equal(list.body.total, 3);
  const s = await mockState();
  assert.equal(s.consignments.filter((c) => c.invoice.startsWith("90")).length, 0, "imports never book");
});

await step("search by tracking code, CSV export, dashboard, customers", async () => {
  const s = await call("GET", `/api/orders?search=${consignmentA.trackingCode}`);
  assert.equal(s.body.total, 1);
  const csv = await call("GET", "/api/orders/export.csv", undefined, { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.body, /Tracking code/);
  assert.match(csv.body, /#5001/);
  const dash = await call("GET", "/api/dashboard?days=30");
  assert.equal(dash.status, 200);
  assert.ok(dash.body.today.orders >= 2);
  assert.equal(dash.body.successRate, 50);
  const cust = await call("GET", "/api/customers?search=Karim");
  assert.equal(cust.body.rows[0].orders, 2);
  const det = await call("GET", `/api/customers/${cust.body.rows[0].id}`);
  assert.equal(det.body.history.delivered, 1);
});

await step("notes, bulk tags, print data", async () => {
  const n = await call("POST", `/api/orders/${orderA.id}/notes`, { kind: "customer_review", body: "Happy with quality", rating: 5 });
  assert.equal(n.status, 200);
  const b = await call("POST", "/api/orders/bulk", { ids: [orderA.id, orderB.id], action: "add_tag", value: "eid" });
  assert.equal(b.body.updated, 2);
  const t = await call("GET", "/api/orders?tag=eid");
  assert.equal(t.body.total, 2);
  const p = await call("GET", `/api/orders/print?ids=${orderA.id}`);
  assert.equal(p.body.orders[0].consignment.trackingCode, consignmentA.trackingCode);
});

await step("Shopify connection test + webhook registration (uses client credentials)", async () => {
  const t = await call("POST", "/api/settings/test/shopify");
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  const s = await mockState();
  assert.ok(s.tokenRequests >= 1);
  const sf = await call("POST", "/api/settings/test/steadfast");
  assert.equal(sf.body.balance, 15230.5);
});

await step("staff permissions are enforced", async () => {
  const u = await call("POST", "/api/users", { name: "Packer", email: "packer@arvono.test", password: "packer-password", role: "packer" });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const ownerCookie = cookie;
  const login = await call("POST", "/api/auth/login", { email: "packer@arvono.test", password: "packer-password" });
  assert.equal(login.status, 200);
  const book = await call("POST", "/api/orders/book", { ids: [orderA.id] });
  assert.equal(book.status, 403);
  const list = await call("GET", "/api/orders");
  assert.equal(list.status, 200);
  const users = await call("GET", "/api/users");
  assert.equal(users.status, 403);
  cookie = ownerCookie;
  const bad = await call("POST", "/api/auth/login", { email: "owner@arvono.test", password: "wrong-password" }, { jar: false });
  assert.equal(bad.status, 401);
});

await step("activity log records actions", async () => {
  const a = await call("GET", "/api/logs/activity");
  const actions = new Set(a.body.rows.map((r) => r.action));
  for (const x of ["courier.booked", "courier.status", "order.fulfilled", "return.created"]) assert.ok(actions.has(x), `missing ${x}`);
});

console.log(`\n${passed} e2e checks passed`);
