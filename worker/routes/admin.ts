import { Hono } from "hono";
import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb } from "../db";
import { activityLog, apiKeys, customStatuses, idempotencyKeys, jobs, orders, sessions, users, webhookEvents } from "../db/schema";
import { API_SCOPES } from "./dispatch";
import { randomToken, sha256Hex } from "../lib/crypto";
import { requirePerm } from "../lib/auth";
import { hashPassword } from "../lib/crypto";
import { nowIso } from "../lib/util";
import { logActivity } from "../services/activity";
import { getSettings, saveSettings, getValues } from "../services/settings";
import { diagnoseShopify, getShopInfo, listWebhookSubscriptions, registerWebhooks, resetShopifyToken, shopifyConfigured } from "../services/shopify";
import { CREDENTIAL_KEYS, describeCredentials, loadCredentials, normalizeShopDomain, saveCredentials, type Credentials } from "../services/credentials";
import { getBalance, steadfastConfigured } from "../services/steadfast";
import { getImportState, latestRuns, reconcileShopify, recordRun, retryFailedWebhooks, runImportStep, startImport, syncPayments } from "../services/sync";
import { processJobs, enqueueJob } from "../services/jobs";
import { pollActiveConsignments } from "../services/courier";
import { ALL_PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "../../shared/constants";

// ---------------------------------------------------------------------------
// Settings & connections

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const origin = new URL(c.req.url).origin;
  const state = await getValues(db, ["shopify.reconcileWatermark", "shopify.import", "cron.lastRun"]);
  return c.json({
    settings: await getSettings(db),
    statuses: await db.select().from(customStatuses).orderBy(customStatuses.sortOrder).all(),
    credentials: c.get("user").permissions.includes("settings.manage") ? await describeCredentials(c.env) : null,
    steadfastWebhookToken: c.get("user").permissions.includes("settings.manage") ? c.env.STEADFAST_WEBHOOK_TOKEN ?? null : null,
    encryptedAtRest: Boolean(c.env.APP_ENCRYPTION_KEY),
    connections: {
      shopify: {
        configured: shopifyConfigured(c.env),
        shopDomain: c.env.SHOPIFY_SHOP_DOMAIN,
        apiVersion: c.env.SHOPIFY_API_VERSION,
        authMode: c.env.SHOPIFY_ACCESS_TOKEN ? "access_token" : "client_credentials",
        webhookSecret: Boolean(c.env.SHOPIFY_WEBHOOK_SECRET || c.env.SHOPIFY_CLIENT_SECRET),
        webhookUrl: `${origin}/webhooks/shopify`,
      },
      steadfast: {
        configured: steadfastConfigured(c.env),
        baseUrl: c.env.STEADFAST_BASE_URL,
        webhookToken: Boolean(c.env.STEADFAST_WEBHOOK_TOKEN),
        webhookUrl: `${origin}/webhooks/steadfast`,
      },
    },
    sync: state,
  });
});

// Connection credentials, editable from the dashboard. Values are never returned unmasked,
// except the Steadfast webhook token which must be pasted into the Steadfast panel.
settingsRoutes.put("/connections", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<Partial<Record<keyof Credentials, string | null>>>();
  const current = await loadCredentials(c.env, true);
  const next: Credentials = { ...current };
  for (const k of CREDENTIAL_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null) delete next[k];
    else if (typeof v === "string" && v.trim()) next[k] = k === "SHOPIFY_SHOP_DOMAIN" ? normalizeShopDomain(v) : v.trim();
  }
  if (typeof body.STEADFAST_WEBHOOK_TOKEN === "string" && body.STEADFAST_WEBHOOK_TOKEN.trim().length < 16) {
    return c.json({ error: "Webhook token must be at least 16 characters" }, 400);
  }
  if (body.STEADFAST_WEBHOOK_TOKEN === null) return c.json({ error: "The webhook token can be changed but not removed" }, 400);
  if (next.SHOPIFY_SHOP_DOMAIN && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(next.SHOPIFY_SHOP_DOMAIN)) {
    return c.json({ error: "Store domain must be the permanent *.myshopify.com domain (e.g. arvono.myshopify.com)" }, 400);
  }
  await saveCredentials(c.env, next);
  await resetShopifyToken(db);
  await logActivity(db, c.get("user"), "settings.connections_updated", {
    details: { changed: CREDENTIAL_KEYS.filter((k) => k in body) },
  });
  return c.json({ ok: true, credentials: await describeCredentials(c.env) });
});

settingsRoutes.post("/connections/regenerate-webhook-token", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const current = await loadCredentials(c.env, true);
  await saveCredentials(c.env, { ...current, STEADFAST_WEBHOOK_TOKEN: randomToken(24) });
  await logActivity(db, c.get("user"), "settings.webhook_token_regenerated");
  return c.json({ ok: true });
});

settingsRoutes.put("/", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json();
  const saved = await saveSettings(db, body);
  await logActivity(db, c.get("user"), "settings.updated", { details: body });
  return c.json({ settings: saved });
});

settingsRoutes.post("/test/shopify", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const steps = await diagnoseShopify(c.env, db);
  if (steps.some((s) => !s.ok)) return c.json({ ok: false, error: steps.find((s) => !s.ok)!.detail, steps });
  try {
    const [shop, hooks] = await Promise.all([getShopInfo(c.env, db), listWebhookSubscriptions(c.env, db)]);
    return c.json({ ok: true, shop, webhooks: hooks, steps });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message, steps });
  }
});

settingsRoutes.post("/test/steadfast", requirePerm("settings.manage"), async (c) => {
  try {
    return c.json({ ok: true, balance: await getBalance(c.env) });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message });
  }
});

settingsRoutes.post("/shopify/webhooks", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const url = `${new URL(c.req.url).origin}/webhooks/shopify`;
  if (!url.startsWith("https://")) return c.json({ error: "Webhooks require the deployed https:// URL" }, 400);
  const results = await registerWebhooks(c.env, db, url);
  await logActivity(db, c.get("user"), "shopify.webhooks_registered", { details: results });
  return c.json({ results });
});

// Custom order statuses
settingsRoutes.post("/statuses", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ name: string; color?: string; blocksBooking?: boolean }>();
  if (!body.name?.trim()) return c.json({ error: "Name is required" }, 400);
  const max = (await db.select({ m: sql<number>`coalesce(max(${customStatuses.sortOrder}), 0)` }).from(customStatuses).get())?.m ?? 0;
  const row = await db
    .insert(customStatuses)
    .values({ name: body.name.trim().slice(0, 40), color: body.color ?? "gray", blocksBooking: Boolean(body.blocksBooking), sortOrder: max + 1 })
    .returning()
    .get();
  return c.json({ status: row });
});

settingsRoutes.patch("/statuses/:id{[0-9]+}", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string; color?: string; blocksBooking?: boolean; isDefault?: boolean; sortOrder?: number }>();
  if (body.isDefault) await db.update(customStatuses).set({ isDefault: false });
  const patch: Partial<typeof customStatuses.$inferInsert> = {};
  if (body.name?.trim()) patch.name = body.name.trim().slice(0, 40);
  if (body.color) patch.color = body.color;
  if (typeof body.blocksBooking === "boolean") patch.blocksBooking = body.blocksBooking;
  if (typeof body.isDefault === "boolean") patch.isDefault = body.isDefault;
  if (typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;
  if (Object.keys(patch).length) await db.update(customStatuses).set(patch).where(eq(customStatuses.id, id));
  return c.json({ ok: true });
});

settingsRoutes.delete("/statuses/:id{[0-9]+}", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  await db.update(orders).set({ statusId: null }).where(eq(orders.statusId, id));
  await db.delete(customStatuses).where(eq(customStatuses.id, id));
  return c.json({ ok: true });
});

// API keys for external services (label printing service)
settingsRoutes.get("/api-keys", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all();
  return c.json({ keys: rows.map(({ keyHash: _h, ...k }) => k), scopes: API_SCOPES });
});

settingsRoutes.post("/api-keys", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const { name, scopes } = await c.req.json<{ name: string; scopes: string[] }>();
  const valid = (scopes ?? []).filter((s) => s in API_SCOPES);
  if (!name?.trim() || !valid.length) return c.json({ error: "Name and at least one scope are required" }, 400);
  const secret = `arv_${randomToken(24)}`;
  const row = await db
    .insert(apiKeys)
    .values({ name: name.trim().slice(0, 60), prefix: secret.slice(0, 10), keyHash: await sha256Hex(secret), scopes: valid, createdBy: c.get("user").id, createdAt: nowIso() })
    .returning({ id: apiKeys.id })
    .get();
  await logActivity(db, c.get("user"), "apikey.created", { entityType: "api_key", entityId: row!.id, details: { name, scopes: valid } });
  // The secret is shown exactly once.
  return c.json({ id: row!.id, key: secret });
});

settingsRoutes.post("/api-keys/:id{[0-9]+}/revoke", requirePerm("settings.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  await db.update(apiKeys).set({ revokedAt: nowIso() }).where(eq(apiKeys.id, id));
  await logActivity(db, c.get("user"), "apikey.revoked", { entityType: "api_key", entityId: id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Staff accounts

export const userRoutes = new Hono<AppEnv>();
userRoutes.use("*", requirePerm("users.manage"));

const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  permissions: u.permissions,
  active: u.active,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

userRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(users).orderBy(users.createdAt).all();
  return c.json({ users: rows.map(publicUser), roles: ROLES, rolePermissions: ROLE_PERMISSIONS });
});

userRoutes.post("/", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ email: string; name: string; password: string; role: string; permissions?: string[] | null }>();
  const email = body.email?.trim().toLowerCase();
  if (!email?.includes("@") || !body.name?.trim()) return c.json({ error: "Name and email are required" }, 400);
  if (!body.password || body.password.length < 10) return c.json({ error: "Password must be at least 10 characters" }, 400);
  if (!ROLES.includes(body.role as (typeof ROLES)[number]) || body.role === "owner") return c.json({ error: "Invalid role" }, 400);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (existing) return c.json({ error: "A user with this email already exists" }, 409);
  const row = await db
    .insert(users)
    .values({
      email,
      name: body.name.trim(),
      passwordHash: await hashPassword(body.password),
      role: body.role,
      permissions: body.permissions ? body.permissions.filter((p) => (ALL_PERMISSIONS as string[]).includes(p)) : null,
      createdAt: nowIso(),
    })
    .returning()
    .get();
  await logActivity(db, c.get("user"), "user.created", { entityType: "user", entityId: row!.id, details: { email, role: body.role } });
  return c.json({ user: publicUser(row!) });
});

userRoutes.patch("/:id{[0-9]+}", async (c) => {
  const db = getDb(c.env.DB);
  const id = Number(c.req.param("id"));
  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json({ error: "User not found" }, 404);
  const body = await c.req.json<{ name?: string; role?: string; permissions?: string[] | null; active?: boolean; password?: string }>();
  const me = c.get("user");
  if (target.role === "owner" && me.id !== target.id) return c.json({ error: "The owner account can only be changed by the owner" }, 403);
  const patch: Partial<typeof users.$inferInsert> = {};
  if (body.name?.trim()) patch.name = body.name.trim();
  if (body.role && target.role !== "owner") {
    if (!ROLES.includes(body.role as (typeof ROLES)[number]) || body.role === "owner") return c.json({ error: "Invalid role" }, 400);
    patch.role = body.role;
  }
  if (body.permissions !== undefined) patch.permissions = body.permissions ? body.permissions.filter((p) => (ALL_PERMISSIONS as string[]).includes(p)) : null;
  if (typeof body.active === "boolean") {
    if (target.role === "owner") return c.json({ error: "The owner cannot be deactivated" }, 400);
    patch.active = body.active;
  }
  if (body.password) {
    if (body.password.length < 10) return c.json({ error: "Password must be at least 10 characters" }, 400);
    patch.passwordHash = await hashPassword(body.password);
  }
  if (Object.keys(patch).length) await db.update(users).set(patch).where(eq(users.id, id));
  if (patch.active === false || patch.passwordHash) await db.delete(sessions).where(eq(sessions.userId, id));
  await logActivity(db, me, "user.updated", { entityType: "user", entityId: id, details: { ...body, password: body.password ? "(changed)" : undefined } });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Logs & sync controls

export const logRoutes = new Hono<AppEnv>();
logRoutes.use("*", requirePerm("logs.view"));

logRoutes.get("/activity", async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page) || 1);
  const conds: SQL[] = [];
  if (q.action) conds.push(sql`${activityLog.action} like ${q.action + "%"}`);
  if (q.actor) conds.push(eq(activityLog.actor, q.actor));
  if (q.orderId) conds.push(eq(activityLog.orderId, Number(q.orderId)));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({ a: activityLog, orderName: orders.name })
    .from(activityLog)
    .leftJoin(orders, eq(orders.id, activityLog.orderId))
    .where(where)
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(100)
    .offset((page - 1) * 100)
    .all();
  const total = await db.select({ n: sql<number>`count(*)` }).from(activityLog).where(where).get();
  return c.json({ rows: rows.map((r) => ({ ...r.a, orderName: r.orderName })), total: total?.n ?? 0, page, pageSize: 100 });
});

logRoutes.get("/sync", async (c) => {
  const db = getDb(c.env.DB);
  const status = c.req.query("webhookStatus");
  const [runs, events, jobRows, importState, counts] = await Promise.all([
    latestRuns(db, 50),
    db
      .select({ id: webhookEvents.id, provider: webhookEvents.provider, topic: webhookEvents.topic, status: webhookEvents.status, attempts: webhookEvents.attempts, error: webhookEvents.error, receivedAt: webhookEvents.receivedAt, processedAt: webhookEvents.processedAt })
      .from(webhookEvents)
      .where(status ? eq(webhookEvents.status, status) : undefined)
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(100)
      .all(),
    db.select().from(jobs).where(inArray(jobs.status, ["pending", "running", "failed"])).orderBy(desc(jobs.updatedAt)).limit(100).all(),
    getImportState(db),
    db.select({ provider: webhookEvents.provider, status: webhookEvents.status, n: sql<number>`count(*)` }).from(webhookEvents).groupBy(webhookEvents.provider, webhookEvents.status).all(),
  ]);
  return c.json({ runs, events, jobs: jobRows, importState, webhookCounts: counts });
});

logRoutes.get("/webhooks/:id{[0-9]+}", async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(webhookEvents).where(eq(webhookEvents.id, Number(c.req.param("id")))).get();
  return row ? c.json({ event: row }) : c.json({ error: "Not found" }, 404);
});

export const syncRoutes = new Hono<AppEnv>();
syncRoutes.use("*", requirePerm("sync.manage"));

syncRoutes.post("/import/start", async (c) => {
  const db = getDb(c.env.DB);
  const { sinceDays } = await c.req.json<{ sinceDays?: number | null }>();
  const state = await startImport(db, sinceDays ?? null);
  await logActivity(db, c.get("user"), "sync.import_started", { details: { sinceDays } });
  const step = await recordRun(db, "shopify_import", "manual", () => runImportStep(c.env, db, 3));
  return c.json({ state: { ...state, ...step }, step });
});

syncRoutes.post("/import/continue", async (c) => {
  const db = getDb(c.env.DB);
  const step = await recordRun(db, "shopify_import", "manual", () => runImportStep(c.env, db, 4));
  return c.json({ step, state: await getImportState(db) });
});

syncRoutes.post("/reconcile", async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await recordRun(db, "shopify_reconcile", "manual", () => reconcileShopify(c.env, db)));
});

syncRoutes.post("/courier", async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await recordRun(db, "courier_poll", "manual", () => pollActiveConsignments(c.env, db, { limit: 40, staleMinutes: 5 })));
});

syncRoutes.post("/payments", async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await recordRun(db, "payments", "manual", () => syncPayments(c.env, db, 3)));
});

syncRoutes.post("/jobs/run", async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await recordRun(db, "jobs", "manual", () => processJobs(c.env, db, { limit: 25 })));
});

syncRoutes.post("/jobs/:id{[0-9]+}/retry", async (c) => {
  const db = getDb(c.env.DB);
  const job = await db.select().from(jobs).where(eq(jobs.id, Number(c.req.param("id")))).get();
  if (!job) return c.json({ error: "Job not found" }, 404);
  await enqueueJob(db, job.type as "fulfill_order", job.key, job.payload, { reset: true });
  return c.json(await processJobs(c.env, db, { ids: [job.id] }));
});

syncRoutes.post("/jobs/:id{[0-9]+}/cancel", async (c) => {
  const db = getDb(c.env.DB);
  await db.update(jobs).set({ status: "cancelled", updatedAt: nowIso() }).where(and(eq(jobs.id, Number(c.req.param("id"))), inArray(jobs.status, ["pending", "failed"])));
  return c.json({ ok: true });
});

syncRoutes.post("/webhooks/retry", async (c) => {
  const db = getDb(c.env.DB);
  const { ids } = await c.req.json<{ ids?: number[] }>();
  return c.json(await retryFailedWebhooks(db, { ids, limit: 50 }));
});

/** Housekeeping: prune old webhook payloads and finished jobs. */
export async function pruneOldData(db: ReturnType<typeof getDb>) {
  const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString();
  await db.delete(webhookEvents).where(and(lt(webhookEvents.receivedAt, cutoff), inArray(webhookEvents.status, ["processed", "ignored"])));
  await db.delete(jobs).where(and(lt(jobs.updatedAt, cutoff), inArray(jobs.status, ["done", "cancelled"])));
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - 7 * 86_400_000).toISOString()));
}
