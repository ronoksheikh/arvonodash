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
import { orderRoutes } from "./routes/orders";
import { consignmentRoutes } from "./routes/consignments";
import { codRoutes, customerRoutes, dashboardRoutes, returnRoutes } from "./routes/misc";
import { logRoutes, pruneOldData, settingsRoutes, syncRoutes, userRoutes } from "./routes/admin";
import { processJobs } from "./services/jobs";
import { pollActiveConsignments } from "./services/courier";
import { getImportState, reconcileShopify, recordRun, retryFailedWebhooks, runImportStep, syncPayments } from "./services/sync";
import { shopifyConfigured } from "./services/shopify";
import { steadfastConfigured } from "./services/steadfast";
import { setValue } from "./services/settings";
import { ensureMigrated } from "./db/migrate";
import { hydrateEnv } from "./services/credentials";

const app = new Hono<AppEnv>();

app.use("*", secureHeaders());

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
  const steps: [string, () => Promise<Record<string, unknown>>, boolean][] = [
    ["print_reservations", () => expireReservations(db).then((r) => ({ ...r, processed: r.expired })), true],
    ["jobs", () => processJobs(env, db, { limit: 25 }), true],
    ["webhook_retry", () => retryFailedWebhooks(db, { limit: 20 }), true],
    ["courier_poll", () => pollActiveConsignments(env, db, { limit: 40, staleMinutes: 30 }), steadfastConfigured(env)],
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
    if (minute % 15 < 5) await recordRun(db, "shopify_reconcile", "cron", () => reconcileShopify(env, db)).catch(() => {});
  }
  if (steadfastConfigured(env) && minute < 5 && hour % 3 === 0) {
    await recordRun(db, "payments", "cron", () => syncPayments(env, db, 2)).catch(() => {});
  }
  if (minute < 5 && hour === 21) await pruneOldData(db); // ~03:00 Asia/Dhaka
  await setValue(db, "cron.lastRun", nowIso());
}

/** Every entry point: apply pending migrations, then fill in credentials saved from the dashboard. */
async function prepare(env: Env): Promise<Env> {
  await ensureMigrated(env.DB);
  return hydrateEnv(env);
}

export default {
  fetch: async (request, env, ctx) => {
    const url = new URL(request.url);
    // Static assets never reach here (assets are served first except /api and /webhooks).
    if (url.pathname === "/api/health") return app.fetch(request, env, ctx);
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
