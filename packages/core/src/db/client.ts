import { Database } from "bun:sqlite";
import { SERVER_SCHEMA, MIGRATIONS } from "./schema.ts";

export type { Database };

/**
 * Initialize (or open) a SQLite database at `path`, applying the SERVER_SCHEMA
 * idempotently and running any pending column migrations.
 * The returned handle is a thin wrapper around bun:sqlite's synchronous API.
 */
export function initDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SERVER_SCHEMA);
  // Apply migrations individually; "duplicate column" errors are safe to skip.
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
  }
  return db;
}
