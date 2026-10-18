/// <reference types="vite/client" />

/**
 * Applies pending SQL migrations from /migrations at startup, so a deploy needs no manual
 * `wrangler d1 migrations apply`. Uses the same `d1_migrations` table as Wrangler, so both
 * methods stay compatible. Each migration runs in one D1 batch (a transaction) together with
 * its bookkeeping row, so concurrent isolates cannot apply it twice.
 */
const files = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const MIGRATIONS = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

let done: Promise<void> | null = null;

export function ensureMigrated(db: D1Database): Promise<void> {
  done ??= migrate(db).catch((err) => {
    done = null; // retry on the next request
    throw err;
  });
  return done;
}

async function migrate(db: D1Database) {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)")
    .run();
  const applied = new Set((await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const statements = m.sql
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    try {
      await db.batch([...statements.map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name)]);
    } catch (err) {
      // Another isolate may have applied it concurrently.
      const row = await db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").bind(m.name).first();
      if (!row) throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
}
