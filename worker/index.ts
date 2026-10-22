import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./env";
import { getDb } from "./db";
import { syncRuns } from "./db/schema";
import { requireAuth, requirePerm } from "./lib/auth";
import { HttpError, nowIso } from "./lib/util";
import { authRoutes } from "./routes/auth";
import { webhookRoutes } from "./routes/webhooks";
import { dispatchRoutes } from "./routes/dispatch";
import { expireReservations } from "./services/dispatch";
import { rollOverMissedPickups } from "./services/pickup";
import { syncAttribution } from "./services/attribution";
import { backfillRisk } from "./services/riskScore";
import { orderRoutes } from "./routes/orders";
import { opsRoutes } from "./routes/ops";
import { consignmentRoutes } from "./routes/consignments";
import { codRoutes, customerRoutes, dashboardRoutes, returnRoutes } from "./routes/misc";
import { logRoutes, pruneOldData, settingsRoutes, syncRoutes, userRoutes } from "./routes/admin";
import { processJobs } from "./services/jobs";
import { pollActiveConsignments } from "./services/courier";
import { getImportState, reconcileShopify, recordRun, retryFailedWebhooks, runImportStep, syncPayments, syncRecentOpenOrders, verifyShopifyOrdersExist } from "./services/sync";
import { runAutoBookings } from "./services/autobook";
import { shopifyConfigured } from "./services/shopify";
import { steadfastConfigured } from "./services/steadfast";
import { carrybeeConfigured } from "./services/carrybee";
import { getSettings, setValue } from "./services/settings";
import { ensureMigrated } from "./db/migrate";
import { hydrateEnv } from "./services/credentials";
import { buildTracking, instanceId, trackingHost } from "./services/tracking";

const app = new Hono<AppEnv>();

const security = secureHeaders();
// WebSocket upgrade responses are immutable, so the scan socket skips header middleware.
app.use("*", (c, next) => (c.req.path.endsWith("/scan/ws") ? next() : security(c, next)));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, details: err.details }, err.status as 400);
  console.error(err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, time: nowIso() }));
app.route("/webhooks", webhookRoutes);
// External + dashboard dispatch API (API key or session). Registered before the session-only /api router.
app.route("/api/v1/dispatch", dispatchRoutes);
app.route("/api/auth", authRoutes);
// Customer-facing tracking page data (no login; the token in the link is the secret).
// Lets Settings confirm, from the browser, that the tracking domain reaches this installation over HTTPS.
app.get("/api/public/domain-check", async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "no-store");
  return c.json({ app: "arvono-tracking", instanceId: await instanceId(getDb(c.env.DB)), host: new URL(c.req.url).host });
});
app.get("/api/public/track/:token", async (c) => {
  const data = await buildTracking(getDb(c.env.DB), c.req.param("token"));
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (!data) return c.json({ error: "Tracking link not found" }, 404);
  return c.json(data);
});

const api = new Hono<AppEnv>();
api.use("*", requireAuth);
api.use("/orders/*", requirePerm("orders.view"));
api.use("/consignments/*", requirePerm("orders.view"));
api.use("/customers/*", requirePerm("orders.view"));
api.use("/returns/*", requirePerm("orders.view"));
api.use("/dashboard/*", requirePerm("orders.view"));
api.use("/cod/*", requirePerm("cod.view"));
api.route("/dashboard", dashboardRoutes);
api.route("/orders", orderRoutes);
api.route("/consignments", consignmentRoutes);
api.route("/customers", customerRoutes);
api.route("/returns", returnRoutes);
api.route("/cod", codRoutes);
api.route("/settings", settingsRoutes);
api.route("/users", userRoutes);
api.route("/logs", logRoutes);
api.route("/sync", syncRoutes);
api.route("/ops", opsRoutes);
app.route("/api", api);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

/**
 * Cron (every 5 minutes): webhook-failure recovery, background jobs, courier status polling,
 * continuing a historical import, hourly Shopify reconciliation, and periodic COD settlement sync.
 */
async function scheduled(controller: ScheduledController, env: Env) {
  const db = getDb(env.DB);
  const now = new Date(controller.scheduledTime);
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  // Every minute: auto-booking timers. Everything else runs on the 5-minute beat.
  try {
    const r = await runAutoBookings(env, db);
    if (r.processed) await db.insert(syncRuns).values({ kind: "auto_booking", trigger: "cron", status: r.skipped ? "partial" : "success", stats: r, startedAt: nowIso(), finishedAt: nowIso() });
  } catch (err) {
    await db.insert(syncRuns).values({ kind: "auto_booking", trigger: "cron", status: "failed", error: (err as Error).message, startedAt: nowIso(), finishedAt: nowIso() });
  }
  if (minute % 5 !== 0) {
    await setValue(db, "cron.lastRun", nowIso());
    return;
  }
  const steps: [string, () => Promise<Record<string, unknown>>, boolean][] = [
    ["print_reservations", () => expireReservations(db).then((r) => ({ ...r, processed: r.expired })), true],
    ["carry_over", () => rollOverMissedPickups(db, env.APP_TIMEZONE_OFFSET || "+06:00"), true],
    ["jobs", () => processJobs(env, db, { limit: 25 }), true],
    ["webhook_retry", () => retryFailedWebhooks(db, { limit: 20 }), true],
    ["risk_scores", async () => backfillRisk(db, await getSettings(db)), true],
    ["courier_poll", () => pollActiveConsignments(env, db, { limit: 40, staleMinutes: 30 }), steadfastConfigured(env) || carrybeeConfigured(env)],
  ];
  for (const [kind, fn, enabled] of steps) {
    if (!enabled) continue;
    try {
      const startedAt = nowIso();
      const stats = await fn();
      // Only keep history rows for runs that actually did something.
      const busy = Object.entries(stats).some(([k, v]) => ["processed", "retried", "checked"].includes(k) && Number(v) > 0);
      if (busy) {
        const failed = Number(stats.failed ?? 0) + Number(stats.errors ?? 0);
        await db.insert(syncRuns).values({ kind, trigger: "cron", status: failed ? "partial" : "success", stats, startedAt, finishedAt: nowIso() });
      }
    } catch (err) {
      await db.insert(syncRuns).values({ kind, trigger: "cron", status: "failed", error: (err as Error).message, startedAt: nowIso(), finishedAt: nowIso() });
    }
  }

  if (shopifyConfigured(env)) {
    const importState = await getImportState(db);
    if (importState && !importState.done) await recordRun(db, "shopify_import", "cron", () => runImportStep(env, db, 3)).catch(() => {});
    // Every 15 minutes: catch edits made in Shopify admin/mobile whose webhooks were missed.
    if (minute % 15 === 0) await recordRun(db, "shopify_reconcile", "cron", () => reconcileShopify(env, db)).catch(() => {});
    // Every 30 minutes: orders deleted in Shopify whose delete webhook never arrived.
    if (minute % 30 === 0) {
      const r = await verifyShopifyOrdersExist(env, db).catch(() => null);
      if (r && "processed" in r && r.processed) await db.insert(syncRuns).values({ kind: "shopify_deleted", trigger: "cron", status: "success", stats: r, startedAt: nowIso(), finishedAt: nowIso() });
    }
    // Where new orders came from (Shopify builds the customer journey shortly after checkout).
    const sources = await syncAttribution(env, db, { batches: 2 }).catch((err: Error) => ({ processed: 0, error: err.message }));
    if (("processed" in sources && sources.processed) || "error" in sources) {
      await db.insert(syncRuns).values({ kind: "order_sources", trigger: "cron", status: "error" in sources ? "failed" : "success", stats: sources, error: "error" in sources ? String(sources.error) : null, startedAt: nowIso(), finishedAt: nowIso() });
    }
    // Shopify-app changes like "Mark as in progress" don't always fire a webhook.
    await syncRecentOpenOrders(env, db, { days: 3, maxPages: 4 }).catch(() => {});
  }
  if (steadfastConfigured(env) && minute === 0 && hour % 3 === 0) {
    await recordRun(db, "payments", "cron", () => syncPayments(env, db, 2)).catch(() => {});
  }
  if (minute === 0 && hour === 21) await pruneOldData(db); // ~03:00 Asia/Dhaka
  await setValue(db, "cron.lastRun", nowIso());
}

// ---------------------------------------------------------------------------
// Custom tracking domain (CNAME / Workers Custom Domain → this Worker; Cloudflare issues the HTTPS certificate)

async function serveTrackingHost(request: Request, env: Env, ctx: ExecutionContext, storeUrl: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/api/public/")) return app.fetch(request, await prepare(env), ctx);
  if (path === "/" || path === "") return Response.redirect(storeUrl, 302);
  // Short form for SMS: track.arvono.store/<token> → /t/<token>
  const bare = /^\/([a-f0-9]{16,64})\/?$/.exec(path);
  if (bare) return Response.redirect(`${url.origin}/t/${bare[1]}`, 301);
  if (/^\/t\/[a-f0-9]{16,64}\/?$/.test(path) || /^\/(assets\/|favicon)/.test(path) || /\.(js|css|svg|png|ico|woff2?|webmanifest)$/.test(path)) {
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    out.headers.set("Strict-Transport-Security", "max-age=31536000");
    return out;
  }
  // Nothing else (dashboard, login, API, webhooks) is reachable on the public tracking domain.
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0;color:#111"><div style="text-align:center"><p>This page doesn't exist.</p><a href="${storeUrl}" style="color:#000">Visit our store</a></div>`, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
  });
}

/** Every entry point: apply pending migrations, then fill in credentials saved from the dashboard. */
async function prepare(env: Env): Promise<Env> {
  await ensureMigrated(env.DB);
  return hydrateEnv(env);
}

export default {
  fetch: async (request, env, ctx) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return app.fetch(request, env, ctx);
    // The customer tracking domain (e.g. track.arvono.store) only ever shows tracking pages.
    const tracking = await trackingHost(env);
    if (tracking && url.hostname === tracking.host) return serveTrackingHost(request, env, ctx, tracking.storeUrl);
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/webhooks/")) return env.ASSETS.fetch(request);
    try {
      return app.fetch(request, await prepare(env), ctx);
    } catch (err) {
      console.error("startup failed", err);
      return Response.json({ error: `Startup failed: ${(err as Error).message}` }, { status: 503 });
    }
  },
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(prepare(env).then((e) => scheduled(controller, e)));
  },
} satisfies ExportedHandler<Env>;

export { app };
