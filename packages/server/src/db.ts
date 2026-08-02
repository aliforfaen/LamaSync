import { mkdirSync } from "fs";
import { join } from "path";
import { initDb } from "@lamasync/core";
import { Database } from "bun:sqlite";
import { migrateLegacyS3FoldersToBackends } from "./backends.ts";

const dataDir = process.env.LAMASYNC_DATA_DIR ?? "/data";

let _db: Database | null = null;

/**
 * LAMA-222: the legacy per-folder s3_* values must be lifted into
 * `backends` rows BEFORE initDb's MIGRATIONS drop those columns. We open a
 * raw handle, create the backends table (idempotent) and run the lift, then
 * let initDb apply the regular schema + migrations on the real handle.
 */
function applyLegacyLift(path: string): void {
  try {
    const raw = new Database(path, { create: true });
    try {
      raw.exec(`
        CREATE TABLE IF NOT EXISTS backends (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 's3',
          s3_provider TEXT DEFAULT 'other',
          s3_endpoint TEXT,
          s3_region TEXT,
          s3_access_key_id TEXT,
          s3_secret_key_enc TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      migrateLegacyS3FoldersToBackends(raw);
    } finally {
      raw.close();
    }
  } catch (error) {
    console.error(
      `[db] legacy S3 lift skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Returns the singleton Database, initializing it on first call. Safe from
 *  tests where the default path may not be writable. */
export function getDb(): Database {
  if (!_db) {
    try { mkdirSync(dataDir, { recursive: true }); } catch { /* not writable */ }
    try {
      applyLegacyLift(join(dataDir, "lamasync.db"));
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
