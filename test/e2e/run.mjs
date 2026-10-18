// End-to-end test against a running dev server (npm run dev) wired to test/e2e/mock-server.mjs.
// Usage: BASE=http://localhost:5173 MOCK=http://localhost:8790 node test/e2e/run.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:5173";
const MOCK = process.env.MOCK ?? "http://localhost:8790";
const SHOPIFY_SECRET = "shopify-secret";
let SF_TOKEN = "";
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

async function shopifyWebhook(topic, payload, id = crypto.randomUUID(), secret = SHOPIFY_SECRET) {
  // Keep the mock's GraphQL view of the order in sync with what the webhook says.
  if (secret === SHOPIFY_SECRET && payload.line_items) await fetch(`${MOCK}/__orders`, { method: "POST", body: JSON.stringify(payload) });
  const raw = JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return call("POST", "/webhooks/shopify", raw, {
    auth: false,
    headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": hmac, "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": id, "X-Shopify-Shop-Domain": "arvono-test.myshopify.com" },
  });
}

const steadfastWebhook = (payload, token = SF_TOKEN) =>
  call("POST", "/webhooks/steadfast", payload, { auth: false, headers: { Authorization: `Bearer ${token}` } });

let apiKey = "";
const v1 = (method, path, body, { key = apiKey, idem = crypto.randomUUID(), headers = {} } = {}) =>
  call(method, `/api/v1/dispatch${path}`, body, { auth: false, headers: { Authorization: `Bearer ${key}`, ...(method === "POST" && idem ? { "Idempotency-Key": idem } : {}), ...headers } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10);
const orderDetail = async (id) => (await call("GET", `/api/orders/${id}`)).body;

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

await step("connections are configured from the dashboard (no secrets file)", async () => {
  const before = await call("GET", "/api/settings");
  assert.equal(before.body.connections.shopify.configured, false);
  assert.ok(before.body.steadfastWebhookToken?.length >= 32, "webhook token auto-generated");
  const bad = await call("PUT", "/api/settings/connections", { SHOPIFY_SHOP_DOMAIN: "arvono.com" });
  assert.equal(bad.status, 400);
  const r = await call("PUT", "/api/settings/connections", {
    SHOPIFY_SHOP_DOMAIN: "https://Arvono-Test.myshopify.com/",
    SHOPIFY_CLIENT_ID: "test-client",
    SHOPIFY_CLIENT_SECRET: SHOPIFY_SECRET,
    STEADFAST_API_KEY: "sf-key",
    STEADFAST_SECRET_KEY: "sf-secret",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.credentials.SHOPIFY_CLIENT_SECRET.hint, "••••cret", "secrets only returned masked");
  const after = await call("GET", "/api/settings");
  assert.equal(after.body.connections.shopify.configured, true);
  for (const k of ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "STEADFAST_API_KEY", "STEADFAST_WEBHOOK_TOKEN"]) {
    assert.equal(after.body.credentials[k].source, "dashboard", `${k} stays editable in Settings`);
  }
  assert.equal(after.body.connections.shopify.shopDomain, "arvono-test.myshopify.com");
  assert.equal(after.body.connections.steadfast.configured, true);
  assert.ok(!JSON.stringify(after.body).includes(SHOPIFY_SECRET), "client secret never sent to browser");
  SF_TOKEN = after.body.steadfastWebhookToken;
});

await step("credentials can be changed and removed from Settings", async () => {
  const oldToken = SF_TOKEN;
  const short = await call("PUT", "/api/settings/connections", { STEADFAST_WEBHOOK_TOKEN: "short" });
  assert.equal(short.status, 400);
  const custom = "arvono-custom-webhook-token-123";
  await call("PUT", "/api/settings/connections", { STEADFAST_WEBHOOK_TOKEN: custom });
  const s1 = await call("GET", "/api/settings");
  assert.equal(s1.body.steadfastWebhookToken, custom);
  await sleep(5200); // credential cache window
  const rejected = await call("POST", "/webhooks/steadfast", { consignment_id: 1, status: "pending" }, { auth: false, headers: { Authorization: `Bearer ${oldToken}` } });
  assert.equal(rejected.status, 401, "old token stops working");
  SF_TOKEN = custom;
  await call("PUT", "/api/settings/connections", { STEADFAST_API_KEY: null });
  const s2 = await call("GET", "/api/settings");
  assert.equal(s2.body.connections.steadfast.configured, false);
  await call("PUT", "/api/settings/connections", { STEADFAST_API_KEY: "sf-key" });
  const s3 = await call("GET", "/api/settings");
  assert.equal(s3.body.connections.steadfast.configured, true);
  const cannotRemove = await call("PUT", "/api/settings/connections", { STEADFAST_WEBHOOK_TOKEN: null });
  assert.equal(cannotRemove.status, 400);
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
  assert.equal(orderA.callingStatus, "not_called");
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

await step("booking requires a confirmed call", async () => {
  const r = await call("POST", "/api/orders/book", { ids: [orderA.id] });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /not confirmed/);
  const list = await call("GET", "/api/orders?tab=to_call");
  assert.equal(list.body.total, 2);
  assert.equal(list.body.rows[0].callingStatus, "not_called");
});

await step("calling: no answer, then confirmed → In progress natively in Shopify", async () => {
  const na = await call("POST", `/api/orders/${orderA.id}/calling`, { status: "no_answer", note: "Rang twice" });
  assert.equal(na.status, 200, JSON.stringify(na.body));
  const ok = await call("POST", `/api/orders/${orderA.id}/calling`, { status: "confirmed", note: "Customer confirmed size L" });
  assert.equal(ok.body.processingStatus, "in_progress");
  await sleep(800);
  const s = await mockState();
  assert.ok(s.progressReports.some((r) => r.id === "gid://shopify/FulfillmentOrder/50011"), "fulfillmentOrderReportProgress called");
  const d = await orderDetail(orderA.id);
  assert.equal(d.order.callingStatus, "confirmed");
  assert.equal(d.order.callAttempts, 2);
  assert.equal(d.order.shopifySyncStatus, "synced");
  assert.equal(d.calls.length, 2);
  assert.equal(d.calls[0].note, "Customer confirmed size L");
  const ready = await call("GET", "/api/orders?tab=ready");
  assert.equal(ready.body.total, 1);
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
  assert.equal(d.body.order.labelStatus, "unprinted");
});

await step("dispatch API: API key auth, scopes and idempotency key required", async () => {
  const k = await call("POST", "/api/settings/api-keys", { name: "Label service", scopes: ["dispatch:read", "dispatch:print", "dispatch:dispatch"] });
  assert.equal(k.status, 200, JSON.stringify(k.body));
  apiKey = k.body.key;
  const ro = await call("POST", "/api/settings/api-keys", { name: "Read only", scopes: ["dispatch:read"] });
  const bad = await v1("GET", "/printable", undefined, { key: "arv_nope" });
  assert.equal(bad.status, 401);
  const noIdem = await v1("POST", "/claim", { date: today }, { idem: null });
  assert.equal(noIdem.status, 400);
  const scoped = await v1("POST", "/claim", { date: today }, { key: ro.body.key });
  assert.equal(scoped.status, 403);
});

await step("printable lists booked order with label data (Dhaka date)", async () => {
  const r = await v1("GET", `/printable?date=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, 1);
  const o = r.body.orders[0];
  assert.equal(o.orderName, "#5001");
  assert.equal(o.invoice, "5001");
  assert.equal(o.trackingCode, consignmentA.trackingCode);
  assert.equal(o.codAmount, 900);
  assert.equal(o.customer.phone, "01812345678");
  assert.deepEqual(o.items, [{ title: "Cotton Panjabi", variant: "L", sku: "PJ-L", quantity: 1 }], "only the items in this consignment");
  assert.equal(o.labelStatus, "unprinted");
  const other = await v1("GET", "/printable?date=2020-01-01");
  assert.equal(other.body.count, 0);
  const fetchedAgain = await v1("GET", `/printable?date=${today}`);
  assert.equal(fetchedAgain.body.orders[0].labelStatus, "unprinted", "fetching never changes state");
});

let jobA;
await step("concurrent claims never hand out the same order", async () => {
  const [c1, c2] = await Promise.all([v1("POST", "/claim", { date: today }), v1("POST", "/claim", { date: today })]);
  const all = [...c1.body.orders, ...c2.body.orders].map((o) => o.orderId);
  assert.equal(all.length, 1, JSON.stringify([c1.body, c2.body]));
  jobA = c1.body.jobId ?? c2.body.jobId;
  const again = await v1("POST", "/claim", { date: today });
  assert.equal(again.body.count, 0);
  const reserved = await v1("GET", `/printable?date=${today}&status=reserved`);
  assert.equal(reserved.body.count, 1);
});

await step("dispatch requires a printed label; release returns order to the pool", async () => {
  const early = await v1("POST", "/mark-dispatched", { orderIds: [orderA.id] });
  assert.equal(early.body.results[0].result, "label_not_printed");
  const rel = await v1("POST", "/release", { jobId: jobA, reason: "printer jam" });
  assert.equal(rel.body.released, 1);
  const c = await v1("POST", "/claim", { date: today, limit: 10 });
  assert.equal(c.body.count, 1);
  jobA = c.body.jobId;
});

await step("expired reservations are recovered; a late confirmation is still honoured", async () => {
  const { execSync } = await import("node:child_process");
  execSync(`npx wrangler d1 execute DB --local --command "UPDATE orders SET reserved_until = '2000-01-01T00:00:00.000Z' WHERE label_status = 'reserved'"`, { stdio: "ignore" });
  const r = await v1("GET", `/printable?date=${today}`);
  assert.equal(r.body.count, 1, "back in the unprinted pool");
  const job = (await v1("GET", `/jobs/${jobA}`)).body;
  assert.ok(job.events.some((e) => e.event === "expired"));
});

await step("printed confirmation marks only confirmed labels; replays are idempotent", async () => {
  const idem = crypto.randomUUID();
  const p = await v1("POST", "/printed", { jobId: jobA, orderIds: [orderA.id] }, { idem });
  assert.equal(p.body.printed, 1, JSON.stringify(p.body));
  const replay = await v1("POST", "/printed", { jobId: jobA, orderIds: [orderA.id] }, { idem });
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(replay.body, p.body);
  const mismatch = await v1("POST", "/printed", { jobId: jobA, orderIds: [] }, { idem });
  assert.equal(mismatch.status, 422);
  const dup = await v1("POST", "/printed", { orderIds: [orderA.id] });
  assert.equal(dup.body.results[0].result, "already_printed");
  const r = await v1("GET", `/printable?date=${today}`);
  assert.equal(r.body.count, 0, "printed orders never come back automatically");
  const claim = await v1("POST", "/claim", { date: today });
  assert.equal(claim.body.count, 0);
});

await step("manual reprint needs a reason and is audited", async () => {
  const noReason = await call("POST", "/api/v1/dispatch/reprint", { orderIds: [orderA.id] });
  assert.equal(noReason.status, 400);
  const ok = await call("POST", "/api/v1/dispatch/reprint", { orderIds: [orderA.id], reason: "Label smudged" });
  assert.deepEqual(ok.body.requeued, [orderA.id]);
  const c = await v1("POST", "/claim", { date: today });
  await v1("POST", "/printed", { jobId: c.body.jobId });
  const d = await orderDetail(orderA.id);
  assert.equal(d.order.printCount, 2);
  assert.ok(d.dispatchHistory.some((e) => e.event === "reprint_requested" && e.note === "Label smudged"));
});

await step("summary reports daily totals; mark-dispatched records handover", async () => {
  const s1 = await v1("GET", `/summary?date=${today}`);
  assert.equal(s1.body.bookedConsignments, 1);
  assert.equal(s1.body.printed, 1);
  assert.equal(s1.body.awaitingDispatch, 1);
  assert.equal(s1.body.confirmedOrders, 1);
  const m = await v1("POST", "/mark-dispatched", { orderIds: [orderA.id, 999999] });
  assert.equal(m.body.dispatched, 1);
  assert.equal(m.body.results[1].result, "not_found");
  const again = await v1("POST", "/mark-dispatched", { orderIds: [orderA.id] });
  assert.equal(again.body.results[0].result, "already_dispatched");
  const s2 = await v1("GET", `/summary?date=${today}`);
  assert.equal(s2.body.dispatched, 1);
  assert.equal(s2.body.awaitingDispatch, 0);
  const d = await orderDetail(orderA.id);
  assert.equal(d.order.fulfillmentState, "none", "dispatch alone never fulfills");
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
  assert.equal(d.body.order.dispatchStatus, "courier_received");
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
  await call("POST", `/api/orders/${orderB.id}/calling`, { status: "confirmed" });
  const r = await call("POST", "/api/orders/book", { ids: [orderB.id] });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /blocks booking/);
  await call("PATCH", `/api/orders/${orderB.id}`, { statusId: null });
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
  const d = await orderDetail(orderB.id);
  assert.equal(d.order.labelStatus, "unprinted", "rebooked parcel needs a new label");
  assert.equal(d.order.dispatchStatus, "pending");
});

await step("Shopify-side cancellation removes order from printing", async () => {
  await shopifyWebhook("orders/create", restOrder(5003, { shipping_address: { name: "Rafi", address1: "Flat 3B, Uttara Sector 7", city: "Dhaka", phone: "01911222333" } }));
  const c = (await call("GET", "/api/orders?search=%235003")).body.rows[0];
  await call("POST", `/api/orders/${c.id}/calling`, { status: "confirmed" });
  const b = await call("POST", "/api/orders/book", { ids: [c.id] });
  assert.equal(b.body.results[0].ok, true);
  let r = await v1("GET", `/printable?date=${today}`);
  assert.ok(r.body.orders.some((o) => o.orderId === c.id));
  await shopifyWebhook("orders/cancelled", restOrder(5003, { cancelled_at: new Date().toISOString(), updated_at: new Date(Date.now() + 1000).toISOString(), shipping_address: { name: "Rafi", address1: "Flat 3B, Uttara Sector 7", city: "Dhaka", phone: "01911222333" } }));
  r = await v1("GET", `/printable?date=${today}`);
  assert.ok(!r.body.orders.some((o) => o.orderId === c.id), "cancelled orders are never printable");
  const att = await call("GET", "/api/orders?tab=attention");
  assert.ok(att.body.rows.some((o) => o.id === c.id), "cancelled-after-booking needs attention");
});

await step("edits made in Shopify admin/mobile sync back (In progress, address change)", async () => {
  const base = restOrder(5004, { shipping_address: { name: "Nadia", address1: "House 9, Banani Road 11", city: "Dhaka", phone: "01555666777" } });
  await shopifyWebhook("orders/create", base);
  const o = (await call("GET", "/api/orders?search=%235004")).body.rows[0];
  assert.equal(o.callingStatus, "not_called");
  await fetch(`${MOCK}/__fo_status`, { method: "POST", body: JSON.stringify({ orderId: "5004", status: "IN_PROGRESS" }) });
  await shopifyWebhook("orders/updated", { ...base, updated_at: new Date(Date.now() + 2000).toISOString() });
  await sleep(1000);
  let d = await orderDetail(o.id);
  assert.equal(d.order.callingStatus, "confirmed", "Shopify In progress counts as confirmation");
  assert.equal(d.order.processingStatus, "in_progress");
  await call("POST", "/api/orders/book", { ids: [o.id] });
  const moved = { ...base, updated_at: new Date(Date.now() + 4000).toISOString(), shipping_address: { ...base.shipping_address, address1: "House 22, Gulshan Avenue" } };
  await shopifyWebhook("orders/updated", moved);
  d = await orderDetail(o.id);
  assert.equal(d.order.address1, "House 22, Gulshan Avenue");
  assert.ok(d.order.riskFlags.includes("changed_after_booking"));
});

await step("cancel fake order in Shopify (no refund) and delete-or-archive fallback", async () => {
  await shopifyWebhook("orders/create", restOrder(5005, { shipping_address: { name: "Fake Person", address1: "asdf", city: "Dhaka", phone: "01700000000" } }));
  const o = (await call("GET", "/api/orders?search=%235005")).body.rows[0];
  await call("POST", `/api/orders/${o.id}/calling`, { status: "rejected", note: "Number says never ordered" });
  const bad = await call("POST", `/api/orders/${o.id}/cancel`, { reason: "NOPE" });
  assert.equal(bad.status, 400);
  const c = await call("POST", `/api/orders/${o.id}/cancel`, { reason: "FRAUD", restock: true, staffNote: "Fake order" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const s = await mockState();
  const cancelled = s.cancelled.find((x) => x.id === "5005");
  assert.equal(cancelled.reason, "FRAUD");
  assert.equal(cancelled.refundMethod.originalPaymentMethodsRefund, false);
  await sleep(3800);
  const d = await orderDetail(o.id);
  assert.ok(d.order.cancelledAt, "cancellation confirmed from Shopify");
  assert.equal(d.order.processingStatus, "cancelled");
  const del = await call("POST", `/api/orders/${o.id}/delete`);
  assert.equal(del.body.deleted, false);
  assert.equal(del.body.archivedInShopify, true);
  assert.equal(del.body.archivedHere, true);
  const booked = await call("POST", `/api/orders/${orderB.id}/cancel`, { reason: "CUSTOMER" });
  assert.equal(booked.status, 409, "active consignment blocks cancellation");
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
  assert.ok(dash.body.pipeline.toCall >= 0);
  assert.equal(dash.body.successRate, 50);
  const cust = await call("GET", "/api/customers?search=01812345678");
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
  assert.ok(t.body.steps.every((st) => st.ok));
  // A stray access token (e.g. a secret pasted in the wrong field) must be reported clearly.
  await call("PUT", "/api/settings/connections", { SHOPIFY_ACCESS_TOKEN: "wrong-value" });
  const bad = await call("POST", "/api/settings/test/shopify");
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.steps.find((st) => st.step === "Auth mode").detail, /Client ID\/secret are ignored/);
  assert.match(bad.body.error, /401/);
  await call("PUT", "/api/settings/connections", { SHOPIFY_ACCESS_TOKEN: null });
  const fixed = await call("POST", "/api/settings/test/shopify");
  assert.equal(fixed.body.ok, true, JSON.stringify(fixed.body));
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
