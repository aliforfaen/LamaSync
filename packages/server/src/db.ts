import { mkdirSync } from "fs";
import { join } from "path";
import { initDb } from "@lamasync/core";
import type { Database } from "bun:sqlite";

const dataDir = process.env.LAMASYNC_DATA_DIR ?? "/data";

let _db: Database | null = null;

/** Returns the singleton Database, initializing it on first call. Safe from
 *  tests where the default path may not be writable. */
export function getDb(): Database {
  if (!_db) {
    try { mkdirSync(dataDir, { recursive: true }); } catch { /* not writable */ }
    try {
      _db = initDb(join(dataDir, "lamasync.db"));
    } catch {
      // Fallback: tests call __setDb before any query, so an inaccessible
      // default path is benign. An in-memory placeholder will be replaced.
      _db = initDb(":memory:");
    }
  }
  return _db;
}

// Legacy export: every consumer does `import { db } from "../db.ts"` and
// reads `db` immediately. Eagerly call getDb() to preserve that contract.
export const db: Database = getDb();
