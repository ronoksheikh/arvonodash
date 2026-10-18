import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb } from "../db";
import { customStatuses, users } from "../db/schema";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { checkRateLimit, clearRateLimit, createSession, destroySession, loadSessionUser } from "../lib/auth";
import { nowIso } from "../lib/util";
import { logActivity } from "../services/activity";
import { rememberOrigin } from "../services/tracking";

export const authRoutes = new Hono<AppEnv>();

// Optional internal labels. Phone verification uses the dedicated calling status instead.
const DEFAULT_STATUSES = [
  { name: "Hold", color: "gray", isDefault: false, blocksBooking: true },
  { name: "Priority", color: "grape", isDefault: false, blocksBooking: false },
  { name: "Exchange", color: "cyan", isDefault: false, blocksBooking: false },
];

authRoutes.get("/setup-status", async (c) => {
  const db = getDb(c.env.DB);
  const n = (await db.select({ n: sql<number>`count(*)` }).from(users).get())?.n ?? 0;
  return c.json({ needsSetup: n === 0 });
});

/** Creates the first owner account. Only works while no users exist. */
authRoutes.post("/setup", async (c) => {
  if (c.req.header("X-Requested-With") !== "arvono") return c.json({ error: "Missing request header" }, 403);
  const db = getDb(c.env.DB);
  const { email, name, password } = await c.req.json<{ email: string; name: string; password: string }>();
  if (!email?.includes("@") || !name?.trim() || !password || password.length < 10) {
    return c.json({ error: "Name, a valid email and a password of at least 10 characters are required" }, 400);
  }
  const passwordHash = await hashPassword(password);
  // Atomic guard: insert only if the users table is still empty.
  const result = await c.env.DB.prepare(
    "INSERT INTO users (email, name, password_hash, role, active, created_at) SELECT ?, ?, ?, 'owner', 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)",
  )
    .bind(email.trim().toLowerCase(), name.trim(), passwordHash, nowIso())
    .run();
  if (!result.meta.changes) return c.json({ error: "Setup has already been completed" }, 409);
  const user = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
  const hasStatuses = (await db.select({ n: sql<number>`count(*)` }).from(customStatuses).get())?.n ?? 0;
  if (!hasStatuses) {
    await db.insert(customStatuses).values(DEFAULT_STATUSES.map((s, i) => ({ ...s, sortOrder: i })));
  }
  await createSession(c, user!.id);
  await logActivity(db, "system", "setup.completed", { entityType: "user", entityId: user!.id });
  return c.json({ ok: true });
});

authRoutes.post("/login", async (c) => {
  if (c.req.header("X-Requested-With") !== "arvono") return c.json({ error: "Missing request header" }, 403);
  const db = getDb(c.env.DB);
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const normalized = (email ?? "").trim().toLowerCase();
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await checkRateLimit(db, `email:${normalized}`)) || !(await checkRateLimit(db, `ip:${ip}`, 30))) {
    return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  }
  const user = await db.select().from(users).where(eq(users.email, normalized)).get();
  const valid = user ? await verifyPassword(password ?? "", user.passwordHash) : false;
  if (!user || !valid || !user.active) return c.json({ error: "Invalid email or password" }, 401);
  await clearRateLimit(db, `email:${normalized}`);
  await db.update(users).set({ lastLoginAt: nowIso() }).where(eq(users.id, user.id));
  await createSession(c, user.id);
  await logActivity(db, { id: user.id, name: user.name, email: user.email, role: user.role, permissions: [] }, "auth.login", { entityType: "user", entityId: user.id, details: { ip } });
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const user = await loadSessionUser(c);
  if (user) await rememberOrigin(getDb(c.env.DB), new URL(c.req.url).origin);
  // 200 with null keeps the signed-out state free of console errors on the login page.
  return c.json({ user });
});
