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

async function call(method, path, body, opts = {}) {
  const r = await callOnce(method, path, body, opts);
  // The Vite dev server reloads the Worker the first time it discovers a lazily imported module
  // and answers that one request with a plain-text 500 ("fetch failed"). Production is pre-bundled.
  if (r.status === 500 && typeof r.body === "string") {
    await new Promise((res) => setTimeout(res, 1500));
    return callOnce(method, path, body, opts);
  }
  return r;
}

async function callOnce(method, path, body, { auth = true, headers = {}, raw = false, jar = true } = {}) {
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

await step("release returns a reserved order to the pool", async () => {
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

await step("scanning the Steadfast consignment ID (WebSocket) marks the parcel sorted, once", async () => {
  const s1 = await v1("GET", `/summary?date=${today}`);
  assert.equal(s1.body.bookedConsignments, 1);
  assert.equal(s1.body.printed, 1);
  assert.equal(s1.body.awaitingSort, 1);
  assert.equal(s1.body.confirmedOrders, 1);
  const batch = await v1("POST", "/batches", { name: "Evening pickup" });
  assert.ok(batch.body.id);
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/v1/dispatch/scan/ws`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const replies = [];
  const waitFor = (pred) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket timeout")), 10_000);
      const check = () => {
        const hit = replies.find(pred);
        if (hit) {
          clearTimeout(t);
          resolve(hit);
        } else setTimeout(check, 20);
      };
      check();
    });
  ws.onmessage = (e) => replies.push(JSON.parse(e.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WebSocket failed to open"));
  });
  const send = (id, code) => ws.send(JSON.stringify({ t: "scan", id, code, batchId: batch.body.id }));
  send("a1", consignmentA.consignmentId);
  const first = await waitFor((m) => m.id === "a1");
  assert.equal(first.kind, "sorted", JSON.stringify(first));
  assert.equal(first.order.name, "#5001");
  send("a2", consignmentA.consignmentId);
  assert.equal((await waitFor((m) => m.id === "a2")).kind, "duplicate");
  send("a3", consignmentA.trackingCode.toLowerCase());
  assert.equal((await waitFor((m) => m.id === "a3")).kind, "duplicate", "tracking code also resolves");
  send("a4", "99999999");
  assert.equal((await waitFor((m) => m.id === "a4")).kind, "unknown");
  ws.send(JSON.stringify({ t: "summary", batchId: batch.body.id }));
  const sum = await waitFor((m) => m.t === "summary");
  assert.equal(sum.scanned.length, 1);
  ws.close();
  const s2 = await v1("GET", `/summary?date=${today}`);
  assert.equal(s2.body.sorted, 1);
  assert.equal(s2.body.awaitingSort, 0);
  assert.equal(s2.body.dispatched, 0, "scanning never marks dispatched");
  const d = await orderDetail(orderA.id);
  assert.equal(d.order.dispatchStatus, "sorted");
  assert.equal(d.order.fulfillmentState, "none", "sorting alone never fulfills");
  const http = await call("POST", "/api/v1/dispatch/scan", { code: consignmentA.consignmentId });
  assert.equal(http.body.kind, "duplicate", "HTTP fallback works too");
});

await step("pickup checklist: scanned parcels are handed to the rider once", async () => {
  const plan = await call("GET", "/api/ops/pickup");
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const a = plan.body.parcels.find((p) => p.id === orderA.id);
  assert.equal(a.stage, "ready", "scanned = ready for pickup");
  assert.ok(plan.body.cutoffAt && plan.body.pickupAt);
  const none = await call("POST", "/api/ops/pickup/handover", { orderIds: [] });
  assert.equal(none.status, 400);
  const h = await call("POST", "/api/ops/pickup/handover", { orderIds: [orderA.id], riderName: "Rahim", riderPhone: "01711-000111" });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.handed, 1);
  const again = await call("POST", "/api/ops/pickup/handover", { orderIds: [orderA.id] });
  assert.equal(again.status, 409, "a parcel can't be handed over twice");
  const after = await call("GET", "/api/ops/pickup");
  assert.equal(after.body.parcels.find((p) => p.id === orderA.id).stage, "handed_over");
  assert.equal(after.body.pickups[0].riderPhone, "01711000111");
  assert.equal(after.body.pickups[0].confirmedBySteadfast, 0);
  const d = await orderDetail(orderA.id);
  assert.equal(d.order.dispatchStatus, "sorted", "handover alone never marks dispatched");
  assert.ok(d.dispatchHistory.some((e) => e.event === "handed_over" && /Rahim/.test(e.note)));
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
  assert.equal(d.body.order.dispatchStatus, "dispatched", "dispatched only when Steadfast leaves in_review");
  assert.ok(s.tags.some((t) => t.tags.includes("steadfast-booked")), "booked tag job ran");
});

await step("Steadfast pickup confirms the rider's handover", async () => {
  const plan = await call("GET", "/api/ops/pickup");
  assert.equal(plan.body.parcels.find((p) => p.id === orderA.id).stage, "picked_up");
  assert.equal(plan.body.pickups[0].confirmedBySteadfast, 1);
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

await step("customer tracking link shows the whole journey without staff details", async () => {
  const d = await orderDetail(orderA.id);
  assert.match(d.trackingPageUrl, /\/t\/[a-f0-9]{20}$/);
  const token = d.trackingPageUrl.split("/t/")[1];
  const t = await call("GET", `/api/public/track/${token}`, undefined, { auth: false, jar: false });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.headers.get("cache-control"), "no-store");
  assert.equal(t.body.status.key, "delivered");
  assert.equal(t.body.order.name, "#5001");
  assert.equal(t.body.order.codDue, 0);
  const kinds = t.body.timeline.map((e) => e.kind);
  for (const k of ["placed", "call_confirmed", "booked", "packed", "picked_up", "courier_update", "delivered"]) assert.ok(kinds.includes(k), `timeline has ${k}: ${kinds}`);
  assert.equal(kinds[0], "delivered", "newest first");
  assert.ok(t.body.steps.every((s) => s.done));
  assert.ok(t.body.courier.trackingCode);
  assert.ok(!t.body.customer.phone.includes(d.order.phone.slice(3, -3)), "phone is masked");
  const raw = JSON.stringify(t.body);
  assert.ok(!raw.includes("Booked with Steadfast by"), "no staff names or internal notes");
  const bad = await call("GET", "/api/public/track/0123456789abcdef0123", undefined, { auth: false, jar: false });
  assert.equal(bad.status, 404);
  const printable = await v1("GET", `/printable?date=${today}&status=all`);
  assert.equal(printable.body.orders[0].trackingUrl, d.trackingPageUrl, "label API carries the tracking link for QR codes");
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
  const cd = await orderDetail(c.id);
  const stop = await call("POST", "/api/v1/dispatch/scan", { code: cd.consignments[0].consignmentId });
  assert.equal(stop.body.kind, "cancelled", "scanner says STOP for parcels cancelled in Shopify");
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

await step("orders already shipped before ARVONO are linked, not queued", async () => {
  const shipped = restOrder(4001, {
    created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    fulfillment_status: "fulfilled",
    fulfillments: [{ status: "success", tracking_number: "LEGACY123", tracking_company: "Steadfast Courier", tracking_url: null }],
    shipping_address: { name: "Old Buyer", address1: "House 1, Road 1, Mirpur", city: "Dhaka", phone: "01822000111" },
  });
  await shopifyWebhook("orders/create", shipped);
  const other = restOrder(4002, { fulfillment_status: "fulfilled", fulfillments: [{ status: "success", tracking_number: "PTH-998877", tracking_company: "Pathao" }], shipping_address: { name: "Other Courier", address1: "House 2, Road 2, Banani", city: "Dhaka", phone: "01822000222" } });
  await shopifyWebhook("orders/create", other);
  const toCall = await call("GET", "/api/orders?tab=to_call");
  assert.ok(!toCall.body.rows.some((r) => ["#4001", "#4002"].includes(r.name)), "shipped orders are not in the calling queue");
  const o = (await call("GET", "/api/orders?search=%234001")).body.rows[0];
  assert.equal(o.trackingCode, "LEGACY123");
  assert.equal(o.labelStatus, "printed");
  const r = await v1("GET", `/printable?upTo=${today}`);
  assert.ok(!r.body.orders.some((x) => x.orderId === o.id), "never sent to the label printer");
  await call("POST", "/api/sync/courier");
  const d = await orderDetail(o.id);
  assert.equal(d.order.courierStage, "delivered", "courier status fetched by tracking code");
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
  assert.equal(dash.body.successRate, 66.7, "2 delivered (incl. linked legacy parcel) vs 1 returned");
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

await step("confirming starts the auto-booking timer; staff can cancel or book now", async () => {
  await shopifyWebhook("orders/create", restOrder(5006, { shipping_address: { name: "Tanvir Ahmed", address1: "House 6, Road 6, Mohammadpur", city: "Dhaka", phone: "01933444555" } }));
  const o = (await call("GET", "/api/orders?search=%235006")).body.rows[0];
  assert.equal(o.customerOrders, 0, "new customer");
  const r = await call("POST", `/api/orders/${o.id}/calling`, { status: "confirmed" });
  assert.ok(r.body.autoBookAt, "timer started");
  const mins = (Date.parse(r.body.autoBookAt) - Date.now()) / 60_000;
  assert.ok(mins > 9 && mins <= 10.1, `10-minute default (${mins})`);
  await call("POST", `/api/orders/${o.id}/auto-book`, { action: "cancel" });
  let d = await orderDetail(o.id);
  assert.equal(d.order.autoBookAt, null);
  assert.match(d.order.autoBookNote, /cancelled/);
  await call("PUT", "/api/settings", { autoBookDelayMinutes: 0 });
  const restarted = await call("POST", `/api/orders/${o.id}/auto-book`, { action: "restart" });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  await sleep(1100);
  const cron = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
  assert.equal(cron.status, 200);
  await sleep(1500);
  d = await orderDetail(o.id);
  assert.equal(d.order.courierStage, "booked", "auto-booked when the timer ended");
  assert.equal(d.order.labelStatus, "unprinted");
  const second = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
  assert.equal(second.status, 200);
  await sleep(800);
  const s = await mockState();
  assert.equal(s.consignments.filter((c) => c.invoice.startsWith("5006")).length, 1, "booked exactly once");
  await call("PUT", "/api/settings", { autoBookDelayMinutes: 10 });
});

await step("Shopify-app 'In progress' is picked up by dashboard sync even without a webhook", async () => {
  const base = restOrder(5007, { shipping_address: { name: "App Confirm", address1: "House 7, Road 7, Uttara", city: "Dhaka", phone: "01944555666" } });
  await shopifyWebhook("orders/create", base);
  await fetch(`${MOCK}/__fo_status`, { method: "POST", body: JSON.stringify({ orderId: "5007", status: "IN_PROGRESS" }) });
  await sleep(21_000); // quick-sync throttle window
  const r = await call("POST", "/api/orders/sync-now");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = (await call("GET", "/api/orders?search=%235007")).body.rows[0];
  assert.equal(o.callingStatus, "confirmed");
  assert.ok(o.autoBookAt, "auto-booking timer started from Shopify confirmation");
});

await step("stuck parcels: silent and slow parcels surface with rider number; calls are logged", async () => {
  const o = (await call("GET", "/api/orders?search=%235006")).body.rows[0];
  const d = await orderDetail(o.id);
  const c = d.consignments.find((x) => !x.superseded);
  const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
  await steadfastWebhook({ notification_type: "delivery_status", consignment_id: Number(c.consignmentId), invoice: c.invoice, status: "pending", tracking_message: "Assigned to rider Karim (01712345678)", updated_at: sixDaysAgo });
  const r = await call("GET", "/api/ops/stuck");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.parcels.find((x) => x.orderName === "#5006");
  assert.ok(p, "stuck parcel listed");
  const codes = p.reasons.map((x) => x.code);
  assert.ok(codes.includes("no_update") && codes.includes("slow_transit"), codes.join(","));
  assert.deepEqual(p.riderPhones, ["01712345678"]);
  const dash = await call("GET", "/api/dashboard?days=7");
  assert.ok(dash.body.pipeline.stuck >= 1, "nav badge count");
  const empty = await call("POST", `/api/ops/stuck/${p.rowId}/follow-up`, { note: " " });
  assert.equal(empty.status, 400);
  const f = await call("POST", `/api/ops/stuck/${p.rowId}/follow-up`, { note: "Customer will receive tomorrow", snoozeDays: 1 });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const hidden = await call("GET", "/api/ops/stuck");
  assert.ok(!hidden.body.parcels.some((x) => x.orderName === "#5006"), "snoozed");
  assert.ok(hidden.body.snoozed >= 1);
  const all = await call("GET", "/api/ops/stuck?all=1");
  const again = all.body.parcels.find((x) => x.orderName === "#5006");
  assert.equal(again.snoozed, true);
  assert.equal(again.followUpNote, "Customer will receive tomorrow");
  const notes = (await orderDetail(o.id)).notes;
  assert.ok(notes.some((n) => /Customer will receive tomorrow/.test(n.body)), "follow-up added to order notes");
});

await step("owner report: orders, calls, courier, COD and returns by district/product", async () => {
  const from = new Date(Date.now() + 6 * 3_600_000 - 2 * 86_400_000).toISOString().slice(0, 10);
  const r = await call("GET", `/api/ops/report?from=${from}&to=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.orders.received >= 5);
  assert.ok(r.body.orders.confirmed >= 3);
  assert.ok(r.body.courier.booked >= 3);
  assert.ok(r.body.courier.delivered >= 1);
  assert.ok(r.body.courier.dispatched >= 1);
  assert.ok(r.body.money.collected >= 900);
  assert.ok(r.body.callers.some((c) => c.confirmed >= 1));
  assert.equal(typeof r.body.sameDay.beforeCutoff, "number");
  assert.ok(Array.isArray(r.body.worstDistricts) && Array.isArray(r.body.worstProducts));
  const bad = await call("GET", `/api/ops/report?from=${today}&to=${from}`);
  assert.equal(bad.status, 400);
});

// New live order for a specific customer phone (Shopify webhook → ARVONO).
const newOrder = async (id, phone, extra = {}) => {
  await shopifyWebhook(
    "orders/create",
    restOrder(id, { customer: { id: 7000 + id, first_name: "Rafiq", last_name: "Hasan" }, shipping_address: { name: "Rafiq Hasan", address1: "House 9, Road 2, Mirpur", city: "Dhaka", zip: "1216", country: "Bangladesh", phone }, ...extra }),
  );
  return (await call("GET", `/api/orders?search=%23${id}`)).body.rows[0];
};
const runCron = async () => {
  const r = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
  assert.equal(r.status, 200);
  await sleep(1500);
};

await step("Steadfast fraud check: risky customers wait in Call first and are never auto-booked", async () => {
  const phone = "01733333333";
  await fetch(`${MOCK}/__fraud`, { method: "POST", body: JSON.stringify({ phone, profile: { delivery_ratio: 40, cancellation_ratio: 60, volume_band: "medium", total_reports: 2, fraud_categories: ["fake order"] } }) });
  const o = await newOrder(5201, "+880 1733-333333");
  await sleep(1500); // the lookup runs from the job queue right after the webhook
  const d = await orderDetail(o.id);
  assert.equal(d.fraud?.verdict, "risky", JSON.stringify(d.fraud));
  assert.equal(d.fraud.totalReports, 2);
  assert.deepEqual(d.fraud.categories, ["fake order"]);
  assert.ok(d.order.riskFlags.includes("courier_fraud"));
  const cf = await call("GET", "/api/orders?tab=call_first");
  assert.ok(cf.body.rows.some((r) => r.id === o.id), "listed in Call first");
  assert.equal(cf.body.rows.find((r) => r.id === o.id).fraud.verdict, "risky");
  const calls = (await mockState()).fraudCalls[phone];
  await call("POST", `/api/orders/${o.id}/fraud-check`);
  assert.equal((await mockState()).fraudCalls[phone], calls, "a re-check within a minute reuses the cached result");

  await call("PUT", "/api/settings", { autoBookDelayMinutes: 0 });
  await call("POST", `/api/orders/${o.id}/calling`, { status: "confirmed" });
  await sleep(1100);
  await runCron();
  const held = await orderDetail(o.id);
  assert.equal(held.order.courierStage, "unbooked", "risky customer is not auto-booked");
  assert.match(held.order.autoBookNote, /Held for a call/);
  await call("PUT", "/api/settings", { autoBookDelayMinutes: 10 });
  const r = await call("POST", "/api/orders/book", { ids: [o.id] });
  assert.equal(r.body.results[0].ok, true, "staff can still send it after calling");
});

await step("same customer's orders go out as one parcel; both follow it, and are marked paid only once Steadfast confirms", async () => {
  const phone = "+880 1755-555555";
  const a = await newOrder(5301, phone);
  const b = await newOrder(5302, phone, {
    line_items: [{ id: 9101, title: "Tupi", variant_title: null, sku: "TP", quantity: 1, price: "300.00", variant_id: 79 }],
    total_price: "420.00", subtotal_price: "300.00", total_outstanding: "420.00",
  });
  for (const o of [a, b]) await call("POST", `/api/orders/${o.id}/calling`, { status: "confirmed" });
  const list = await call("GET", "/api/orders?search=%235301");
  assert.match(list.body.rows[0].combinableWith, /#5302/);
  assert.deepEqual((await orderDetail(a.id)).combineCandidates.map((x) => x.name), ["#5302"]);

  const r = await call("POST", "/api/orders/book", { ids: [a.id, b.id], combine: true });
  assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
  const parcels = (await mockState()).consignments.filter((c) => c.invoice.startsWith("5301"));
  assert.equal(parcels.length, 1, "one Steadfast parcel");
  assert.equal(parcels[0].invoice, "5301_5302");
  assert.equal(parcels[0].cod_amount, 1250 + 420, "parcel COD covers both orders");
  const second = await orderDetail(b.id);
  assert.equal(second.order.courierStage, "booked");
  assert.equal(second.order.combinedIntoOrderId, a.id);
  assert.equal(second.order.labelStatus, "not_ready", "one label: the parcel's");
  assert.equal(second.parcelOrders.length, 2);
  const printable = await v1("GET", `/printable?date=${today}&status=all`);
  assert.ok(printable.body.orders.some((o) => o.orderId === a.id) && !printable.body.orders.some((o) => o.orderId === b.id));

  const cid = Number(parcels[0].consignment_id);
  const update = (status, extra = {}) => steadfastWebhook({ notification_type: "delivery_status", consignment_id: cid, invoice: "5301_5302", status, updated_at: new Date().toISOString(), ...extra });
  await update("pending");
  await sleep(800);
  for (const o of [a, b]) assert.equal((await orderDetail(o.id)).order.fulfillmentState, "fulfilled", "each order is fulfilled in Shopify");
  await update("delivered_approval_pending", { cod_amount: 1670 });
  await sleep(500);
  assert.equal((await orderDetail(b.id)).order.courierStage, "awaiting_confirmation");
  assert.ok(!(await mockState()).markedPaid.includes("5301"), "not paid on the rider's word alone");
  await update("delivered", { cod_amount: 1670 });
  await sleep(1200);
  const paid = (await mockState()).markedPaid;
  assert.ok(paid.includes("5301") && paid.includes("5302"), JSON.stringify(paid));
  assert.equal((await orderDetail(b.id)).order.courierStage, "delivered");
  const t = await call("GET", `/api/public/track/${second.trackingPageUrl.split("/t/")[1]}`, undefined, { auth: false, jar: false });
  assert.equal(t.body.status.key, "delivered");
  assert.deepEqual(t.body.order.shipsWith, ["#5301"]);
});

await step("auto-booking sends a customer's confirmed orders together as one parcel", async () => {
  const phone = "+880 1777-777777";
  const a = await newOrder(5601, phone);
  const b = await newOrder(5602, phone, { line_items: [{ id: 9601, title: "Cap", variant_title: null, sku: "CP", quantity: 1, price: "350.00", variant_id: 91 }], total_price: "470.00", subtotal_price: "350.00", total_outstanding: "470.00" });
  await sleep(1000);
  await call("PUT", "/api/settings", { autoBookDelayMinutes: 0 });
  for (const o of [a, b]) await call("POST", `/api/orders/${o.id}/calling`, { status: "confirmed" });
  await call("PUT", "/api/settings", { autoBookDelayMinutes: 10 });
  await sleep(1100);
  await runCron();
  const parcels = (await mockState()).consignments.filter((c) => c.invoice.startsWith("5601"));
  assert.equal(parcels.length, 1, JSON.stringify((await orderDetail(a.id)).order.autoBookNote));
  assert.equal(parcels[0].invoice, "5601_5602");
  assert.equal((await orderDetail(b.id)).order.combinedIntoOrderId, a.id);
});

await step("Steadfast portal events (signed) are applied; delivery-charge-only partial is a return", async () => {
  const o = await newOrder(5401, "+880 1766-666666");
  await call("POST", `/api/orders/${o.id}/calling`, { status: "confirmed" });
  const booked = await call("POST", "/api/orders/book", { ids: [o.id] });
  const cid = Number(booked.body.results[0].consignmentId);
  const invoice = "5401";

  const raw = JSON.stringify({ notification_type: "consignment_update", consignment_id: cid, invoice, changed: ["cod_amount", "cus_address"], values: { cod_amount: 900, cus_address: "House 1, Road 1, Mirpur" }, updated_at: "2026-10-18 12:00:00" });
  const signature = crypto.createHmac("sha256", SF_TOKEN).update(raw).digest("hex");
  const forged = await call("POST", "/webhooks/steadfast", raw, { auth: false, headers: { Authorization: `Bearer ${SF_TOKEN}`, "X-Signature": "deadbeef" } });
  assert.equal(forged.status, 401, "wrong signature rejected");
  const signed = await call("POST", "/webhooks/steadfast", raw, { auth: false, headers: { Authorization: `Bearer ${SF_TOKEN}`, "X-Signature": signature } });
  assert.equal(signed.status, 200);
  let d = await orderDetail(o.id);
  assert.equal(d.consignments[0].codAmount, 900);
  assert.equal(d.consignments[0].codChangedFrom, 1250);
  assert.equal(d.consignments[0].recipientAddress, "House 1, Road 1, Mirpur");
  assert.ok(d.order.riskFlags.includes("cod_mismatch"), "COD no longer matches Shopify");
  assert.ok(d.events.some((e) => /Changed in the Steadfast portal/.test(e.message ?? "")));

  await steadfastWebhook({ notification_type: "cancel_request", consignment_id: cid, invoice, cancel_request_id: 77, reason_id: 3, note: "Customer asked to cancel", verify_status: "pending" });
  d = await orderDetail(o.id);
  assert.ok(d.notes.some((n) => /Customer asked to cancel/.test(n.body)), "who asked and why is on the order");

  await steadfastWebhook({ notification_type: "delivery_status", consignment_id: cid, invoice, status: "pending", updated_at: new Date().toISOString() });
  await steadfastWebhook({ notification_type: "delivery_status", consignment_id: cid, invoice, status: "partial_delivered", cod_amount: 120, updated_at: new Date().toISOString() });
  d = await orderDetail(o.id);
  assert.equal(d.consignments[0].partialOutcome, "charge_only");
  assert.ok(d.returns.some((x) => /only the delivery charge/.test(x.reason)), "return expected for the product");
  const t = await call("GET", `/api/public/track/${d.trackingPageUrl.split("/t/")[1]}`, undefined, { auth: false, jar: false });
  assert.match(t.body.status.title, /delivery charge paid/);

  await steadfastWebhook({ notification_type: "return_list_accepted", return_list_id: 9, status: "accepted", item_count: 1, consignments: [{ consignment_id: cid, invoice }] });
  d = await orderDetail(o.id);
  assert.equal(d.returns[0].status, "received", "return list marks the parcel received");
  const pay = await steadfastWebhook({ notification_type: "payment_request", payment_request_id: 12, amount: 5000, method: "bank", status: "pending" });
  assert.equal(pay.status, 200, "account events without a parcel are accepted");
});

await step("missed webhooks: Steadfast's full history fills the timeline, without duplicates", async () => {
  const o = (await call("GET", "/api/orders?search=%235201")).body.rows[0];
  const c = (await orderDetail(o.id)).consignments[0];
  await fetch(`${MOCK}/__history`, { method: "POST", body: JSON.stringify({ invoice: c.invoice, steps: [{ text: "Reached Mirpur hub", created_at: "2026-10-18 15:30:00" }] }) });
  await setCourierStatus(Number(c.consignmentId), "pending");
  await call("POST", "/api/consignments/refresh", { ids: [c.id] });
  await call("POST", "/api/consignments/refresh", { ids: [c.id] });
  const hub = (await orderDetail(o.id)).events.filter((e) => e.message === "Reached Mirpur hub");
  assert.equal(hub.length, 1, "added once");
  assert.equal(hub[0].source, "history");
  assert.equal(hub[0].occurredAt, "2026-10-18T09:30:00.000Z", "Steadfast times are Bangladesh time");
});

await step("a Steadfast 429 pauses all Steadfast calls instead of retrying (no account lockout)", async () => {
  const phone = "01788888888";
  await fetch(`${MOCK}/__fraud`, { method: "POST", body: JSON.stringify({ phone, profile: "429" }) });
  const o = await newOrder(5501, "+880 1788-888888");
  await sleep(1500);
  assert.equal((await mockState()).fraudCalls[phone], 1, "one call, no retry storm");
  const dash = await call("GET", "/api/dashboard?days=7");
  assert.equal(dash.body.steadfastPause?.reason, "rate_limited");
  const r = await call("POST", `/api/orders/${o.id}/fraud-check`);
  assert.equal(r.body.deferred, true);
  assert.equal((await mockState()).fraudCalls[phone], 1, "paused: Steadfast is not called");
  await sleep(2300);
  assert.equal((await call("GET", "/api/dashboard?days=7")).body.steadfastPause, null, "resumes after Retry-After");
});

const book = async (id) => {
  await call("POST", `/api/orders/${id}/calling`, { status: "confirmed" });
  const r = await call("POST", "/api/orders/book", { ids: [id] });
  assert.equal(r.body.results[0].ok, true, JSON.stringify(r.body));
  return (await orderDetail(id)).consignments[0];
};
const smsTo = async (phone) => (await mockState()).sms.filter((m) => m.to === phone);

await step("SMS is off by default; switched on, each order gets each message once, with the tracking-domain link", async () => {
  await newOrder(5701, "+880 1755-500001");
  await sleep(1200);
  assert.equal((await smsTo("01755500001")).length, 0, "nothing is sent while SMS is off");

  const saved = await call("PUT", "/api/settings", { smsEnabled: true, trackingBaseUrl: "track.arvono.store", smsTriggers: { placed: true, confirmed: true, delivered: true } });
  assert.equal(saved.body.settings.trackingBaseUrl, "https://track.arvono.store");
  const o = await newOrder(5702, "+880 1755-500002");
  await sleep(1500);
  let sent = await smsTo("01755500002");
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.match(sent[0].msg, /^Hi Rafiq, thanks for your order #5702/);
  assert.match(sent[0].msg, /https:\/\/track\.arvono\.store\/t\/[a-f0-9]{20}/);

  await call("POST", `/api/orders/${o.id}/calling`, { status: "confirmed" });
  await call("POST", `/api/orders/${o.id}/calling`, { status: "confirmed" });
  await shopifyWebhook("orders/updated", restOrder(5702, { updated_at: new Date(Date.now() + 1000).toISOString(), shipping_address: { name: "Rafiq Hasan", address1: "House 9, Road 2, Mirpur", city: "Dhaka", phone: "+880 1755-500002" } }));
  await sleep(1500);
  sent = await smsTo("01755500002");
  assert.equal(sent.length, 2, "placed + confirmed, no repeats");
  assert.match(sent[1].msg, /confirmed/);

  const d = await orderDetail(o.id);
  assert.match(d.trackingPageUrl, /^https:\/\/track\.arvono\.store\/t\//, "staff copy the public link too");
  assert.equal(d.sms.length, 2);
  assert.ok(d.journey.entries.some((e) => e.source === "sms"));
});

await step("staff can send a custom SMS with placeholders; provider errors are shown, not retried", async () => {
  const o = (await call("GET", "/api/orders?search=%235702")).body.rows[0];
  const r = await call("POST", `/api/orders/${o.id}/sms`, { body: "Hello {name}, about {order}: {oops}" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const last = (await smsTo("01755500002")).at(-1);
  assert.equal(last.msg, "Hello Rafiq, about #5702: {oops}");

  await fetch(`${MOCK}/__sms_code`, { method: "POST", body: JSON.stringify({ code: 417 }) });
  const fail = await call("POST", `/api/orders/${o.id}/sms`, { body: "Second message" });
  assert.equal(fail.status, 422);
  assert.match(fail.body.error, /Insufficient SMS balance/);
  const settings = (await call("GET", "/api/settings")).body;
  assert.equal(settings.sms.lastError.code, 417);
  assert.equal(settings.sms.configured, true);
  await fetch(`${MOCK}/__sms_code`, { method: "POST", body: JSON.stringify({ code: 0 }) });
  assert.equal((await call("GET", "/api/settings/sms/balance")).body.balance, 512.25);
  const caller = await call("POST", "/api/settings/sms/preview", { template: "{name} {order} {cod}", orderId: o.id });
  assert.equal(caller.body.text, "Rafiq #5702 Tk 1,250");
  assert.equal(JSON.stringify(settings).includes("sms-key"), false, "the API key never reaches the browser");
});

await step("order deleted in Shopify after booking: flagged and stopped; then deleted in Steadfast → 'deleted', not 'unknown'", async () => {
  const o = await newOrder(5801, "+880 1755-500003");
  const c = await book(o.id);
  const del = await shopifyWebhook("orders/delete", { id: 5801 });
  assert.equal(del.status, 200);
  let d = await orderDetail(o.id);
  assert.ok(d.order.shopifyDeletedAt, "deletion recorded");
  assert.ok(d.order.cancelledAt, "treated as cancelled everywhere");
  assert.equal(d.order.archived, false, "kept visible while its parcel is live");
  assert.ok(d.order.riskFlags.includes("deleted_in_shopify"));
  const scan = await call("POST", "/api/v1/dispatch/scan", { code: c.consignmentId });
  assert.equal(scan.body.kind, "cancelled", "scanner says STOP");
  assert.ok((await call("GET", "/api/orders?tab=attention")).body.rows.some((r) => r.id === o.id), "needs attention");

  // Someone deletes the parcel in the Steadfast portal: Steadfast no longer knows it.
  await fetch(`${MOCK}/api/v1/__delete_consignment`, { method: "POST", headers: { "Api-Key": "sf-key", "Secret-Key": "sf-secret" }, body: JSON.stringify({ consignment_id: Number(c.consignmentId) }) });
  await call("POST", "/api/consignments/refresh", { ids: [c.id] });
  d = await orderDetail(o.id);
  assert.equal(d.consignments[0].status, "deleted");
  assert.equal(d.consignments[0].stage, "cancelled");
  assert.equal(d.order.courierStage, "cancelled");
  assert.ok(!d.order.riskFlags.includes("deleted_in_shopify"), "nothing left to stop");
  assert.ok(d.journey.entries.some((e) => e.title === "Deleted in Shopify"));
});

await step("a cancelled parcel that Steadfast later reports as 'unknown' is recorded as deleted, never regressed", async () => {
  const o = await newOrder(5802, "+880 1755-500004");
  const c = await book(o.id);
  const sf = (path, body) => fetch(`${MOCK}/api/v1${path}`, { method: "POST", headers: { "Api-Key": "sf-key", "Secret-Key": "sf-secret" }, body: JSON.stringify(body) });
  await sf("/__set_status", { consignment_id: Number(c.consignmentId), status: "cancelled" });
  await call("POST", "/api/consignments/refresh", { ids: [c.id] });
  assert.equal((await orderDetail(o.id)).consignments[0].status, "cancelled");
  await sf("/__set_status", { consignment_id: Number(c.consignmentId), status: "unknown" });
  await call("POST", "/api/consignments/refresh", { ids: [c.id] });
  const d = await orderDetail(o.id);
  assert.equal(d.consignments[0].status, "deleted", "not 'unknown'");
  assert.equal(d.order.courierStage, "cancelled");
  assert.ok(!d.events.some((e) => e.status === "unknown"));
  // A delivered parcel never goes back to an open status from a poll.
  const o2 = await newOrder(5803, "+880 1755-500005");
  const c2 = await book(o2.id);
  await sf("/__set_status", { consignment_id: Number(c2.consignmentId), status: "delivered" });
  await call("POST", "/api/consignments/refresh", { ids: [c2.id] });
  await sf("/__set_status", { consignment_id: Number(c2.consignmentId), status: "pending" });
  await call("POST", "/api/consignments/refresh", { ids: [c2.id] });
  assert.equal((await orderDetail(o2.id)).consignments[0].status, "delivered");
});

await step("an order deleted in Shopify without a webhook is found by the existence check", async () => {
  const o = await newOrder(5804, "+880 1755-500006");
  await fetch(`${MOCK}/__delete_order`, { method: "POST", body: JSON.stringify({ id: 5804 }) });
  let r;
  for (let i = 0; i < 20; i++) {
    r = await call("POST", "/api/sync/shopify-deleted");
    if (r.body.deleted?.includes(o.id) || !r.body.scanned) break;
  }
  const d = await orderDetail(o.id);
  assert.ok(d.order.shopifyDeletedAt, JSON.stringify(r.body));
  assert.equal(d.order.archived, true, "nothing was booked, so it is simply archived");
});

await step("pickup: ship-by date from the cut-off, implicit handover on Steadfast pickup, undo handover, carry-over", async () => {
  await call("PUT", "/api/settings", { cutoffTime: "00:00" });
  const late = await newOrder(5901, "+880 1755-500007");
  await book(late.id);
  let plan = (await call("GET", "/api/ops/pickup")).body;
  const p1 = plan.parcels.find((x) => x.id === late.id);
  assert.equal(p1.stage, "next_day", "booked after the cut-off → tomorrow");
  assert.ok(p1.shipBy > plan.date);
  await call("PUT", "/api/settings", { cutoffTime: "23:59" });

  const o = await newOrder(5902, "+880 1755-500008");
  const c = await book(o.id);
  plan = (await call("GET", "/api/ops/pickup")).body;
  assert.equal(plan.parcels.find((x) => x.id === o.id).shipBy, plan.date, "before the cut-off → today");
  await call("POST", "/api/v1/dispatch/scan", { code: c.consignmentId });
  const h = await call("POST", "/api/ops/pickup/handover", { orderIds: [o.id], riderName: "Karim" });
  assert.equal(h.body.handed, 1);
  const undo = await call("POST", "/api/ops/pickup/undo-handover", { orderIds: [o.id], reason: "Rider forgot it" });
  assert.deepEqual(undo.body.reverted, [o.id]);
  plan = (await call("GET", "/api/ops/pickup")).body;
  assert.equal(plan.parcels.find((x) => x.id === o.id).stage, "ready", "back on the pile for the next pickup");

  // Picked up by Steadfast without the checklist (and here, without a packing scan either).
  const o3 = await newOrder(5903, "+880 1755-500009");
  const c3 = await book(o3.id);
  await fetch(`${MOCK}/api/v1/__set_status`, { method: "POST", headers: { "Api-Key": "sf-key", "Secret-Key": "sf-secret" }, body: JSON.stringify({ consignment_id: Number(c3.consignmentId), status: "pending" }) });
  await call("POST", "/api/consignments/refresh", { ids: [c3.id] });
  const d3 = await orderDetail(o3.id);
  assert.equal(d3.order.dispatchStatus, "dispatched");
  assert.ok(d3.journey.milestones.handedOver, "handover filled in from Steadfast's pickup");
  assert.ok(d3.dispatchHistory.some((e) => e.event === "picked_up_unscanned"));

  const roll = await call("POST", "/api/sync/carry-over");
  assert.equal(roll.status, 200);
  assert.equal(roll.body.processed, 0, "nothing is late today");
  const report = (await call("GET", `/api/ops/report?from=${plan.date}&to=${plan.date}`)).body;
  assert.equal(report.sameDay.unscanned >= 1, true);
});

await step("tracking domain serves only tracking pages (dashboard, login, API and webhooks are not reachable there)", async () => {
  const http = await import("node:http");
  const viaHost = (path, host) =>
    new Promise((resolve, reject) => {
      const u = new URL(BASE);
      http.get({ host: u.hostname, port: u.port, path, headers: { Host: `${host}:${u.port}` } }, (r) => {
        let b = "";
        r.on("data", (d) => (b += d));
        r.on("end", () => resolve({ status: r.statusCode, location: r.headers.location, body: b }));
      }).on("error", reject);
    });
  await call("PUT", "/api/settings", { trackingBaseUrl: "https://track.localtest.me" });
  const o = (await call("GET", "/api/orders?search=%235702")).body.rows[0];
  const token = (await orderDetail(o.id)).trackingPageUrl.split("/t/")[1];
  const host = "track.localtest.me";
  assert.equal((await viaHost("/", host)).location, "https://arvono.store/", "bare domain goes to the shop");
  assert.match((await viaHost(`/${token}`, host)).location, new RegExp(`/t/${token}$`), "short link form");
  assert.equal((await viaHost(`/t/${token}`, host)).status, 200);
  const data = await viaHost(`/api/public/track/${token}`, host);
  assert.equal(JSON.parse(data.body).order.name, "#5702");
  assert.equal(JSON.parse((await viaHost("/api/public/domain-check", host)).body).app, "arvono-tracking");
  for (const p of ["/api/auth/me", "/login", "/orders", "/api/orders", "/webhooks/steadfast"]) assert.equal((await viaHost(p, host)).status, 404, p);
  assert.equal((await viaHost("/api/auth/me", "localhost")).status, 200, "the dashboard address is unaffected");
});

await step("journey: one timeline from every source, with milestones", async () => {
  const o = (await call("GET", "/api/orders?search=%235902")).body.rows[0];
  const d = await orderDetail(o.id);
  const sources = new Set(d.journey.entries.map((e) => e.source));
  for (const s of ["shopify", "call", "booking", "warehouse"]) assert.ok(sources.has(s), `missing ${s}`);
  const titles = d.journey.entries.map((e) => e.title);
  for (const t of ["Order placed in Shopify", "Booked with Steadfast", "Scanned & sorted", "Handed to courier rider", "Handover undone (rider didn't take it)"]) assert.ok(titles.includes(t), `missing ${t}: ${titles}`);
  assert.ok(d.journey.milestones.confirmed && d.journey.milestones.booked && d.journey.milestones.packed);
  await call("PUT", "/api/settings", { smsEnabled: false, trackingBaseUrl: "" });
});

await step("activity log records actions", async () => {
  const a = await call("GET", "/api/logs/activity");
  const actions = new Set(a.body.rows.map((r) => r.action));
  for (const x of ["courier.booked", "courier.status", "order.fulfilled", "return.created"]) assert.ok(actions.has(x), `missing ${x}`);
});

console.log(`\n${passed} e2e checks passed`);
