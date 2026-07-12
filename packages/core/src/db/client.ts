import { Database } from "bun:sqlite";
import { SERVER_SCHEMA } from "./schema.ts";

export type { Database };

/**
 * Initialize (or open) a SQLite database at `path`, applying the SERVER_SCHEMA
 * idempotently. The returned handle is a thin wrapper around bun:sqlite's
 * synchronous API.
 */
export function initDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SERVER_SCHEMA);
  return db;
}
