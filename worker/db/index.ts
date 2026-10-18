import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type DB = ReturnType<typeof getDb>;

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export { schema };

import { sql, type SQL, type AnyColumn } from "drizzle-orm";

/**
 * `column IN (...)` for arbitrarily long lists. D1 allows at most 100 bound parameters per query,
 * so the list is passed as a single JSON parameter and expanded with json_each.
 */
export function inList(column: AnyColumn | SQL, values: (string | number)[]): SQL {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}

import { getTableColumns, type Table } from "drizzle-orm";

/** Selects a subset of a table's columns (D1 caps result sets at 100 columns, so wide joins must be trimmed). */
export function pick<T extends Table, K extends keyof T["_"]["columns"]>(table: T, keys: K[]): Pick<T["_"]["columns"], K> {
  const cols = getTableColumns(table) as T["_"]["columns"];
  return Object.fromEntries(keys.map((k) => [k, cols[k]])) as Pick<T["_"]["columns"], K>;
}
