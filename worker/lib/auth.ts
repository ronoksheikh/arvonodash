import { eq, lt } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppEnv, SessionUser } from "../env";
import { getDb, type DB } from "../db";
import { loginAttempts, sessions, users } from "../db/schema";
import { randomToken, sha256Hex } from "./crypto";
import { nowIso } from "./util";
import { ROLE_PERMISSIONS, type Permission, type Role } from "../../shared/constants";

const COOKIE = "arvono_session";
const SESSION_DAYS = 14;

export function permissionsFor(user: { role: string; permissions: string[] | null }): string[] {
  if (user.role === "owner") return ROLE_PERMISSIONS.owner;
  return user.permissions ?? ROLE_PERMISSIONS[user.role as Role] ?? [];
}

export async function createSession(c: Context<AppEnv>, userId: number) {
  const token = randomToken(32);
  const db = getDb(c.env.DB);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    expiresAt: expires.toISOString(),
    createdAt: nowIso(),
    ip: c.req.header("CF-Connecting-IP") ?? null,
    userAgent: c.req.header("User-Agent")?.slice(0, 300) ?? null,
  });
  await db.delete(sessions).where(lt(sessions.expiresAt, nowIso()));
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    expires,
  });
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, COOKIE);
  if (token) await getDb(c.env.DB).delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function loadSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const db = getDb(c.env.DB);
  const id = await sha256Hex(token);
  const row = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row || row.session.expiresAt < nowIso() || !row.user.active) return null;
  // Sliding expiry: extend when less than half the lifetime remains.
  const remaining = Date.parse(row.session.expiresAt) - Date.now();
  if (remaining < (SESSION_DAYS / 2) * 86_400_000) {
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await db.update(sessions).set({ expiresAt: expires.toISOString() }).where(eq(sessions.id, id));
    setCookie(c, COOKIE, token, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", expires });
  }
  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: row.user.role,
    permissions: permissionsFor(row.user),
  };
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  // CSRF defence: state-changing requests must carry a custom header, which cross-site forms cannot set.
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("X-Requested-With") !== "arvono") {
    return c.json({ error: "Missing request header" }, 403);
  }
  const user = await loadSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  c.set("user", user);
  await next();
});

export const requirePerm = (perm: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("user").permissions.includes(perm)) return c.json({ error: "You do not have permission to do this" }, 403);
    await next();
  });

/** Simple fixed-window limiter for login attempts. Returns false when the key is locked out. */
export async function checkRateLimit(db: DB, key: string, max = 10, windowMinutes = 15): Promise<boolean> {
  const now = Date.now();
  const row = await db.select().from(loginAttempts).where(eq(loginAttempts.key, key)).get();
  if (!row || now - Date.parse(row.windowStart) > windowMinutes * 60_000) {
    await db
      .insert(loginAttempts)
      .values({ key, count: 1, windowStart: new Date(now).toISOString() })
      .onConflictDoUpdate({ target: loginAttempts.key, set: { count: 1, windowStart: new Date(now).toISOString() } });
    return true;
  }
  if (row.count >= max) return false;
  await db.update(loginAttempts).set({ count: row.count + 1 }).where(eq(loginAttempts.key, key));
  return true;
}

export async function clearRateLimit(db: DB, key: string) {
  await db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}
