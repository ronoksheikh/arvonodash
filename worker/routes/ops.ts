import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getDb } from "../db";
import { requirePerm } from "../lib/auth";
import { HttpError } from "../lib/util";
import { logActivity } from "../services/activity";
import { businessDate } from "../services/dispatch";
import { confirmHandover, dayPlan } from "../services/pickup";
import { ownerReport } from "../services/report";
import { getSettings } from "../services/settings";
import { recordFollowUp, stuckParcels } from "../services/stuck";

/** Daily operations: same-day pickup plan + handover, stuck parcels, owner report. */
export const opsRoutes = new Hono<AppEnv>();

const tz = (env: AppEnv["Bindings"]) => env.APP_TIMEZONE_OFFSET || "+06:00";

opsRoutes.get("/pickup", requirePerm("orders.view"), async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await dayPlan(db, await getSettings(db), tz(c.env)));
});

opsRoutes.post("/pickup/handover", requirePerm("dispatch.manage"), async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ orderIds?: unknown; riderName?: string; riderPhone?: string; note?: string }>();
  const ids = Array.isArray(body.orderIds) ? body.orderIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
  if (ids.length > 2000) throw new HttpError(400, "Too many parcels in one handover");
  const user = c.get("user");
  const r = await confirmHandover(db, user, await getSettings(db), tz(c.env), { orderIds: ids, riderName: body.riderName, riderPhone: body.riderPhone, note: body.note });
  await logActivity(db, user, "dispatch.handover", { entityType: "pickup", entityId: r.pickupId, details: { handed: r.handed, leftBehind: r.leftBehind, rider: body.riderName ?? null } });
  return c.json(r);
});

opsRoutes.get("/stuck", requirePerm("orders.view"), async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await stuckParcels(db, await getSettings(db), { includeSnoozed: c.req.query("all") === "1" }));
});

opsRoutes.post("/stuck/:id{[0-9]+}/follow-up", async (c) => {
  const user = c.get("user");
  if (!user.permissions.includes("orders.call") && !user.permissions.includes("courier.manage")) return c.json({ error: "You do not have permission to do this" }, 403);
  const body = await c.req.json<{ note?: string; snoozeDays?: number }>();
  return c.json(await recordFollowUp(getDb(c.env.DB), user, Number(c.req.param("id")), { note: body.note ?? "", snoozeDays: body.snoozeDays }));
});

opsRoutes.get("/report", requirePerm("reports.view"), async (c) => {
  const db = getDb(c.env.DB);
  const today = businessDate(new Date(), tz(c.env));
  const from = c.req.query("from") || today;
  const to = c.req.query("to") || from;
  if (to < from) throw new HttpError(400, "'to' must not be before 'from'");
  return c.json(await ownerReport(db, await getSettings(db), tz(c.env), from, to));
});
