import type { DB } from "../db";
import { activityLog } from "../db/schema";
import { nowIso } from "../lib/util";
import type { SessionUser } from "../env";

export type Actor = SessionUser | "system" | "shopify" | "steadfast" | "carrybee";

export async function logActivity(
  db: DB,
  actor: Actor,
  action: string,
  opts: { entityType?: string; entityId?: string | number; orderId?: number | null; details?: unknown } = {},
) {
  const isUser = typeof actor === "object";
  await db.insert(activityLog).values({
    userId: isUser ? actor.id : null,
    actor: isUser ? actor.name : actor,
    action,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId !== undefined ? String(opts.entityId) : null,
    orderId: opts.orderId ?? null,
    details: opts.details ?? null,
    createdAt: nowIso(),
  });
}
