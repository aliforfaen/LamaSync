import { Database } from "bun:sqlite";
import { SERVER_SCHEMA, MIGRATIONS, LEGACY_S3_DROP_MIGRATIONS } from "./schema.ts";
import { convertLegacyAppConfig } from "./app-config-migration.ts";

export type { Database };

export interface InitDbOptions {
  /**
   * Also apply the legacy s3_* DROP COLUMN migrations (LAMA-222). Only the
   * server should pass true, and only after the legacy lift succeeded or
   * found nothing to lift — dropping on a failed lift destroys the only
   * copy of the S3 credentials (P0-3). Defaults to false.
   */
  dropLegacyS3Columns?: boolean;
}

/**
 * Initialize (or open) a SQLite database at `path`, applying the SERVER_SCHEMA
 * idempotently and running any pending column migrations.
 * The returned handle is a thin wrapper around bun:sqlite's synchronous API.
 */
export function initDb(path: string, options: InitDbOptions = {}): Database {
  const db = new Database(path, { create: true });
  db.exec(SERVER_SCHEMA);
  // Apply migrations individually; "duplicate column" errors are safe to skip.
  const migrations = options.dropLegacyS3Columns
    ? [...MIGRATIONS, ...LEGACY_S3_DROP_MIGRATIONS]
    : MIGRATIONS;
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists / already dropped — safe to ignore */ }
  }
  // LAMA-316: convert legacy dotfile/profile/_global config to the
  // application templates/protections contract. Idempotent and a no-op on
  // fresh databases.
  convertLegacyAppConfig(db);
  return db;
}
