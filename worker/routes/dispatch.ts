import { trackingBase } from "../services/tracking";
import { getSettings } from "../services/settings";
import { Hono, type Context } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import type { Env, SessionUser } from "../env";
import { getDb, pick } from "../db";
import { apiKeys, consignments, dispatchEvents, idempotencyKeys, orders, printJobs } from "../db/schema";
import { loadSessionUser } from "../lib/auth";
import { sha256Hex } from "../lib/crypto";
import { HttpError, nowIso } from "../lib/util";
import * as dispatch from "../services/dispatch";
import { logActivity } from "../services/activity";

/**
 * Dispatch & label printing API — /api/v1/dispatch/*
 * Used by the external label service (API key) and by the dashboard (session cookie).
 * Documented in docs/DISPATCH_API.md.
 */

type Caller = { kind: "api_key"; keyId: number; name: string; scopes: string[] } | { kind: "user"; user: SessionUser };
type DispatchEnv = { Bindings: Env; Variables: { caller: Caller; user: SessionUser } };

export const API_SCOPES = {
  "dispatch:read": "Read printable orders and summaries",
  "dispatch:print": "Claim, confirm and release print jobs",
  "dispatch:dispatch": "Mark parcels as dispatched",
} as const;

const PERMISSION_FOR_SCOPE: Record<string, string> = {
  "dispatch:read": "orders.view",
  "dispatch:print": "dispatch.manage",
  "dispatch:dispatch": "dispatch.manage",
};

const authenticate = createMiddleware<DispatchEnv>(async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const db = getDb(c.env.DB);
    const key = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, await sha256Hex(auth.slice(7).trim()))).get();
    if (!key || key.revokedAt) return c.json({ error: "Invalid or revoked API key" }, 401);
    if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > 60_000) {
      await db.update(apiKeys).set({ lastUsedAt: nowIso() }).where(eq(apiKeys.id, key.id));
    }
    c.set("caller", { kind: "api_key", keyId: key.id, name: `api:${key.name}`, scopes: key.scopes });
    return next();
  }
  if (c.req.method !== "GET" && c.req.header("X-Requested-With") !== "arvono") return c.json({ error: "Missing request header" }, 403);
  const user = await loadSessionUser(c as unknown as Context);
  if (!user) return c.json({ error: "Authentication required (Bearer API key)" }, 401);
  c.set("caller", { kind: "user", user });
  c.set("user", user);
  return next();
});

const requireScope = (scope: keyof typeof API_SCOPES, userPermission?: string) =>
  createMiddleware<DispatchEnv>(async (c, next) => {
    const caller = c.get("caller");
    if (caller.kind === "api_key") {
      if (!caller.scopes.includes(scope)) return c.json({ error: `API key lacks scope ${scope}` }, 403);
    } else if (!caller.user.permissions.includes(userPermission ?? PERMISSION_FOR_SCOPE[scope])) {
      return c.json({ error: "You do not have permission to do this" }, 403);
    }
    return next();
  });

const sessionOnly = (permission: string) =>
  createMiddleware<DispatchEnv>(async (c, next) => {
    const caller = c.get("caller");
    if (caller.kind !== "user") return c.json({ error: "This action is only available to signed-in staff" }, 403);
    if (!caller.user.permissions.includes(permission)) return c.json({ error: "You do not have permission to do this" }, 403);
    return next();
  });

const actorOf = (c: Context<DispatchEnv>): dispatch.Actor => {
  const caller = c.get("caller");
  return caller.kind === "api_key" ? { name: caller.name } : { name: caller.user.name, id: caller.user.id };
};

/**
 * Idempotency for POSTs: the first response for (caller, Idempotency-Key) is stored and replayed
 * for retries with the same body. Required for API-key callers.
 */
async function idempotent(c: Context<DispatchEnv>, handler: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>) {
  const db = getDb(c.env.DB);
  const caller = c.get("caller");
  const raw = await c.req.text();
  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key) {
    if (caller.kind === "api_key") return c.json({ error: "Idempotency-Key header is required" }, 400);
    const r = await handler(body);
    return c.json(r.body as object, r.status as 200);
  }
  if (key.length > 200) return c.json({ error: "Idempotency-Key too long" }, 400);
  const scope = caller.kind === "api_key" ? `key:${caller.keyId}` : `user:${caller.user.id}`;
  const endpoint = new URL(c.req.url).pathname;
  const requestHash = await sha256Hex(`${endpoint}\n${raw}`);
  const inserted = await db
    .insert(idempotencyKeys)
    .values({ scope, key, endpoint, requestHash, createdAt: nowIso() })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key })
    .get();
  if (!inserted) {
    const prev = await db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key))).get();
    // A "processing" record older than 2 minutes belongs to a request that died mid-flight.
    if (prev && prev.status !== "done" && prev.requestHash === requestHash && Date.now() - Date.parse(prev.createdAt) > 120_000) {
      await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
      return idempotent(c, handler);
    }
    if (prev?.requestHash !== requestHash) return c.json({ error: "Idempotency-Key was already used with a different request" }, 422);
    if (prev.status !== "done") return c.json({ error: "A request with this Idempotency-Key is still being processed" }, 409);
    c.header("Idempotent-Replayed", "true");
    return c.json(JSON.parse(prev.responseBody ?? "{}"), (prev.responseStatus ?? 200) as 200);
  }
  try {
    const r = await handler(body);
    await db
      .update(idempotencyKeys)
      .set({ status: "done", responseStatus: r.status, responseBody: JSON.stringify(r.body) })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    return c.json(r.body as object, r.status as 200);
  } catch (err) {
    // Nothing was committed for this key; allow the client to retry with it.
    await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    throw err;
  }
}

function rangeFrom(c: Context<DispatchEnv>, q: Record<string, unknown>): { from?: string; to?: string; label: string } {
  const offset = c.env.APP_TIMEZONE_OFFSET || "+06:00";
  const get = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  if (get("upTo")) {
    // Everything booked up to and including this business date (next-day dispatch backlog).
    const r = dispatch.dayRange(get("upTo")!, offset);
    return { from: "1970-01-01T00:00:00.000Z", to: r.to, label: `up to ${get("upTo")}` };
  }
  if (get("from")) {
    const r = dispatch.dayRange(get("from")!, offset, get("to") ?? get("from"));
    return { ...r, label: `${get("from")}..${get("to") ?? get("from")}` };
  }
  const date = get("date") ?? dispatch.businessDate(new Date(), offset);
  return { ...dispatch.dayRange(date, offset), label: date };
}

const ids = (v: unknown, field: string, max = 500): number[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x <= 0)) throw new HttpError(400, `${field} must be an array of order IDs`);
  if (v.length > max) throw new HttpError(400, `${field} accepts at most ${max} IDs`);
  return [...new Set(v as number[])];
};

export const dispatchRoutes = new Hono<DispatchEnv>();
dispatchRoutes.use("*", authenticate);

/** Label QR/links use the public tracking domain when one is set (Settings → Tracking page). */
async function absoluteUrls(c: Context<DispatchEnv>, list: dispatch.PrintableOrder[]) {
  const db = getDb(c.env.DB);
  const base = (await trackingBase(db, await getSettings(db), new URL(c.req.url).origin)).replace(/\/$/, "");
  return list.map((o) => ({ ...o, trackingUrl: o.trackingUrl ? base + o.trackingUrl : null }));
}

dispatchRoutes.get("/printable", requireScope("dispatch:read"), async (c) => {
  const q = c.req.query();
  const range = rangeFrom(c, q);
  const status = (["unprinted", "reserved", "printed", "all"].includes(q.status ?? "") ? q.status : "unprinted") as "unprinted";
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
  const db = getDb(c.env.DB);
  await dispatch.expireReservations(db);
  const r = await dispatch.listByLabelStatus(db, { ...range, status, limit, afterId: Number(q.cursor) || undefined, offset: c.env.APP_TIMEZONE_OFFSET || "+06:00" });
  return c.json({ range: range.label, timezone: "Asia/Dhaka", status, count: r.orders.length, nextCursor: r.nextCursor, orders: await absoluteUrls(c, r.orders) });
});

dispatchRoutes.post("/claim", requireScope("dispatch:print"), (c) =>
  idempotent(c, async (body) => {
    const range = body.orderIds ? { label: "selected" } : rangeFrom(c, body);
    const limit = Math.min(500, Math.max(1, Number(body.limit) || 100));
    const ttlSeconds = Math.min(86_400, Math.max(60, Number(body.ttlSeconds) || 1800));
    const r = await dispatch.claim(getDb(c.env.DB), actorOf(c), {
      ...("from" in range ? { from: range.from, to: range.to } : {}),
      orderIds: ids(body.orderIds, "orderIds"),
      limit,
      ttlSeconds,
      offset: c.env.APP_TIMEZONE_OFFSET || "+06:00",
      filters: { range: range.label, limit, orderIds: body.orderIds ?? null },
    });
    return { status: 200, body: { ...r, orders: await absoluteUrls(c, r.orders), count: r.orders.length } };
  }),
);

dispatchRoutes.post("/printed", requireScope("dispatch:print"), (c) =>
  idempotent(c, async (body) => {
    const r = await dispatch.markPrinted(getDb(c.env.DB), actorOf(c), {
      jobId: typeof body.jobId === "string" ? body.jobId : undefined,
      orderIds: ids(body.orderIds, "orderIds"),
      failedOrderIds: ids(body.failedOrderIds, "failedOrderIds"),
    });
    return { status: 200, body: r };
  }),
);

dispatchRoutes.post("/release", requireScope("dispatch:print"), (c) =>
  idempotent(c, async (body) => {
    const r = await dispatch.release(getDb(c.env.DB), actorOf(c), {
      jobId: typeof body.jobId === "string" ? body.jobId : undefined,
      orderIds: ids(body.orderIds, "orderIds"),
      reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined,
    });
    return { status: 200, body: { released: r.released.length, orderIds: r.released } };
  }),
);

dispatchRoutes.get("/summary", requireScope("dispatch:read"), async (c) => {
  const range = rangeFrom(c, c.req.query());
  const db = getDb(c.env.DB);
  await dispatch.expireReservations(db);
  return c.json({ date: range.label, timezone: "Asia/Dhaka", ...(await dispatch.summary(db, { from: range.from!, to: range.to! })) });
});

// Sorting = label scanned at the packing table. Dispatch is recorded only by Steadfast's pickup.
const markSortedHandler = (c: Context<DispatchEnv>) =>
  idempotent(c, async (body) => {
    const orderIds = ids(body.orderIds, "orderIds");
    if (!orderIds?.length) throw new HttpError(400, "orderIds is required");
    const r = await dispatch.markSorted(getDb(c.env.DB), actorOf(c), orderIds);
    return { status: 200, body: r };
  });
dispatchRoutes.post("/mark-sorted", requireScope("dispatch:dispatch"), markSortedHandler);
dispatchRoutes.post("/mark-dispatched", requireScope("dispatch:dispatch"), markSortedHandler); // legacy alias

/** One scan (HTTP fallback for the WebSocket). */
dispatchRoutes.post("/scan", requireScope("dispatch:dispatch"), async (c) => {
  const body = await c.req.json<{ code: string; batchId?: string | null }>();
  if (!body.code?.trim()) return c.json({ error: "code is required" }, 400);
  return c.json(await dispatch.scanParcel(getDb(c.env.DB), actorOf(c), body.code, body.batchId ?? null));
});

/**
 * Live scanning over a WebSocket (fast path for phones). Messages:
 *   → { t: "scan", id, code, batchId }        ← { t: "result", id, ...ScanResult }
 *   → { t: "summary", batchId }               ← { t: "summary", ...batchSummary }
 *   → { t: "ping" }                           ← { t: "pong" }
 */
dispatchRoutes.get(
  "/scan/ws",
  async (c, next) => {
    // Browsers always send Origin on WebSocket handshakes; refuse cross-site sockets.
    const origin = c.req.header("Origin");
    if (c.get("caller").kind === "user" && origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "Bad origin" }, 403);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Expected a WebSocket upgrade" }, 426);
    await next();
  },
  requireScope("dispatch:dispatch"),
  upgradeWebSocket((c) => {
    const db = getDb(c.env.DB);
    const actor = actorOf(c);
    return {
      async onMessage(evt, ws) {
        let msg: { t?: string; id?: string; code?: string; batchId?: string | null };
        try {
          msg = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        try {
          if (msg.t === "scan" && msg.code) {
            const r = await dispatch.scanParcel(db, actor, msg.code, msg.batchId ?? null);
            ws.send(JSON.stringify({ t: "result", id: msg.id, code: msg.code, ...r }));
          } else if (msg.t === "summary") {
            ws.send(JSON.stringify({ t: "summary", ...(await dispatch.batchSummary(db, msg.batchId ?? null)) }));
          } else if (msg.t === "ping") {
            ws.send(JSON.stringify({ t: "pong" }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ t: "error", id: msg.id, message: (err as Error).message }));
        }
      },
    };
  }),
);

dispatchRoutes.post("/batches", requireScope("dispatch:dispatch"), async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const id = await dispatch.startBatch(getDb(c.env.DB), actorOf(c), body.name);
  return c.json({ id });
});

dispatchRoutes.get("/batches/:id", requireScope("dispatch:read"), async (c) => {
  return c.json(await dispatch.batchSummary(getDb(c.env.DB), c.req.param("id")));
});

dispatchRoutes.post("/batches/:id/close", requireScope("dispatch:dispatch"), async (c) => {
  await dispatch.closeBatch(getDb(c.env.DB), c.req.param("id"));
  return c.json({ ok: true });
});

// ---- Dashboard-only actions ---------------------------------------------

const undoSortHandler = (c: Context<DispatchEnv>) =>
  idempotent(c, async (body) => {
    const orderIds = ids(body.orderIds, "orderIds");
    if (!orderIds?.length || typeof body.reason !== "string" || !body.reason.trim()) throw new HttpError(400, "orderIds and a reason are required");
    const r = await dispatch.unsort(getDb(c.env.DB), actorOf(c), orderIds, body.reason.trim());
    return { status: 200, body: r };
  });
dispatchRoutes.post("/undo-sort", sessionOnly("dispatch.manage"), undoSortHandler);
dispatchRoutes.post("/undo-dispatch", sessionOnly("dispatch.manage"), undoSortHandler); // legacy alias

dispatchRoutes.post("/reprint", sessionOnly("labels.reprint"), (c) =>
  idempotent(c, async (body) => {
    const orderIds = ids(body.orderIds, "orderIds");
    if (!orderIds?.length) throw new HttpError(400, "orderIds is required");
    const db = getDb(c.env.DB);
    const r = await dispatch.requestReprint(db, actorOf(c), orderIds, String(body.reason ?? ""));
    const caller = c.get("caller");
    if (caller.kind === "user") await logActivity(db, caller.user, "labels.reprint_requested", { details: { orderIds: r.requeued, reason: body.reason } });
    return { status: 200, body: r };
  }),
);

dispatchRoutes.get("/jobs", requireScope("dispatch:read"), async (c) => {
  return c.json({ jobs: await dispatch.listJobs(getDb(c.env.DB), Math.min(200, Number(c.req.query("limit")) || 50)) });
});

dispatchRoutes.get("/jobs/:id", requireScope("dispatch:read"), async (c) => {
  const db = getDb(c.env.DB);
  const job = await db.select().from(printJobs).where(eq(printJobs.id, c.req.param("id"))).get();
  if (!job) return c.json({ error: "Print job not found" }, 404);
  const events = await db
    .select({ e: dispatchEvents, orderName: orders.name })
    .from(dispatchEvents)
    .innerJoin(orders, eq(orders.id, dispatchEvents.orderId))
    .where(eq(dispatchEvents.jobId, job.id))
    .orderBy(dispatchEvents.createdAt)
    .all();
  return c.json({ job, events: events.map((x) => ({ ...x.e, orderName: x.orderName })) });
});

/** Dispatch board for the dashboard: orders grouped by physical-handover state. */
dispatchRoutes.get("/board", requireScope("dispatch:read"), async (c) => {
  const db = getDb(c.env.DB);
  const q = c.req.query();
  const view = q.view ?? "ready";
  const range = q.date || q.from || q.upTo ? rangeFrom(c, q) : null;
  // Orders combined into another order's parcel have no label or scan of their own.
  const conds = [eq(orders.archived, false), sql`${orders.activeConsignmentId} is not null and ${orders.combinedIntoOrderId} is null`];
  if (range) conds.push(sql`${orders.bookedAt} >= ${range.from} and ${orders.bookedAt} < ${range.to}`);
  const staleCutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
  switch (view) {
    case "ready": // booked, waiting to be scanned at packing
      conds.push(sql`${orders.dispatchStatus} = 'pending' and ${orders.courierStage} = 'booked' and ${orders.cancelledAt} is null`);
      break;
    case "sorted": // scanned, waiting for Steadfast pickup
      conds.push(sql`${orders.dispatchStatus} = 'sorted'`);
      break;
    case "dispatched": // Steadfast picked it up
      conds.push(sql`${orders.dispatchStatus} = 'dispatched'`);
      break;
    case "exceptions":
      conds.push(sql`(
        ${orders.courierStage} in ('on_hold', 'issue', 'returned', 'partial_delivered')
        or (${orders.cancelledAt} is not null and ${orders.courierStage} in ('booked', 'in_transit', 'on_hold', 'awaiting_confirmation'))
        or (${orders.dispatchStatus} = 'sorted' and ${orders.sortedAt} < ${staleCutoff})
      )`);
      break;
    default:
      throw new HttpError(400, "Unknown view");
  }
  const rows = await db
    .select({
      o: pick(orders, ["id", "name", "customerName", "phone", "city", "courierStage", "cancelledAt", "bookedAt", "labelStatus", "printedAt", "dispatchStatus", "sortedAt", "sortedBy", "dispatchedAt", "fulfillmentState"]),
      c: pick(consignments, ["recipientName", "recipientPhone", "codAmount", "trackingCode", "consignmentId", "status", "lastMessage"]),
    })
    .from(orders)
    .leftJoin(consignments, eq(consignments.id, orders.activeConsignmentId))
    .where(and(...conds))
    .orderBy(desc(orders.bookedAt))
    .limit(Math.min(1000, Number(q.limit) || 500))
    .all();
  const counts = await db
    .select({
      ready: sql<number>`sum(case when ${orders.dispatchStatus} = 'pending' and ${orders.courierStage} = 'booked' and ${orders.cancelledAt} is null then 1 else 0 end)`,
      sorted: sql<number>`sum(case when ${orders.dispatchStatus} = 'sorted' then 1 else 0 end)`,
    })
    .from(orders)
    .where(and(eq(orders.archived, false), range ? sql`${orders.bookedAt} >= ${range.from} and ${orders.bookedAt} < ${range.to}` : undefined))
    .get();
  return c.json({
    view,
    counts: { ready: Number(counts?.ready ?? 0), sorted: Number(counts?.sorted ?? 0) },
    orders: rows.map((r) => ({
      orderId: r.o.id,
      orderName: r.o.name,
      customerName: r.c?.recipientName ?? r.o.customerName,
      phone: r.c?.recipientPhone ?? r.o.phone,
      city: r.o.city,
      codAmount: r.c?.codAmount ?? 0,
      trackingCode: r.c?.trackingCode ?? null,
      consignmentId: r.c?.consignmentId ?? null,
      courierStatus: r.c?.status ?? null,
      courierStage: r.o.courierStage,
      lastMessage: r.c?.lastMessage ?? null,
      cancelledAt: r.o.cancelledAt,
      bookedAt: r.o.bookedAt,
      labelStatus: r.o.labelStatus,
      printedAt: r.o.printedAt,
      dispatchStatus: r.o.dispatchStatus,
      sortedAt: r.o.sortedAt,
      sortedBy: r.o.sortedBy,
      dispatchedAt: r.o.dispatchedAt,
      fulfillmentState: r.o.fulfillmentState,
    })),
  });
});
