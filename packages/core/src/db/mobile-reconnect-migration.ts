// LAMA-337: one-time rebuilds of the mobile credential tables for databases
// created before the reconnect flow.
//
// LAMA-296 shipped both `mobile_enrollments.host_id` and
// `web_grants.registration_id` as UNIQUE, because one enrollment produced one
// brand-new installation and one installation held one web grant. The
// reconnect QR rotates an EXISTING registration's credentials, which needs
// both tables to keep a history:
//
//   mobile_enrollments — many QRs per host (pairing + every reconnect), with a
//                        new `kind` column ('new' | 'reconnect') saying which
//                        flow a row belongs to.
//   web_grants         — the superseded grant is revoked (with a reason) and a
//                        fresh grant row is issued, so the rotation stays
//                        auditable instead of overwriting evidence.
//
// SQLite cannot drop a UNIQUE constraint in place, and `MIGRATIONS` is a list
// of strings that `initDb` applies blindly (there is no conditional DDL in
// SQLite), so these rebuilds are guarded TypeScript steps: each inspects the
// live table and rebuilds only when its shape is not already the target shape.
// That keeps `initDb` idempotent across every boot — a fresh database and an
// already-migrated one are both a no-op. Primary keys and the `*_hash`
// uniqueness constraints are preserved by the rebuilt tables.

import type { Database } from "bun:sqlite";

interface TableRebuild {
  table: string;
  /** Staging table name; dropped before the rebuild starts. */
  staging: string;
  /** DDL of the rebuilt table (must match SERVER_SCHEMA). */
  createSql: string;
  /** Columns copied verbatim from the old table, in order. */
  columns: readonly string[];
  /** Columns the target shape has that the legacy table may lack. They are
   *  left out of the copy, so they take their declared default. */
  addedColumns: readonly string[];
  /** Index names the target shape declares (recreated after the rename). */
  indexes: readonly string[];
  /** Column whose UNIQUE constraint the target shape drops. */
  dropUniqueOn: string;
}

interface IndexListRow {
  name: string;
  unique: number;
}

const REBUILDS: readonly TableRebuild[] = [
  {
    table: "mobile_enrollments",
    staging: "mobile_enrollments_rebuild",
    createSql: `CREATE TABLE mobile_enrollments_rebuild (
      id            TEXT PRIMARY KEY,
      secret_hash   TEXT NOT NULL UNIQUE,
      host_id       TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'new',
      client_type   TEXT NOT NULL DEFAULT 'android',
      web_admin     INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      consumed_at   INTEGER,
      revoked_at    INTEGER
    )`,
    columns: [
      "id",
      "secret_hash",
      "host_id",
      "client_type",
      "web_admin",
      "status",
      "expires_at",
      "created_at",
      "consumed_at",
      "revoked_at",
    ],
    // Every pre-LAMA-337 enrollment was a new installation, which is exactly
    // what the new column defaults to.
    addedColumns: ["kind"],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_mobile_enrollments_status_expires ON mobile_enrollments(status, expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_mobile_enrollments_host_id ON mobile_enrollments(host_id)",
    ],
    dropUniqueOn: "host_id",
  },
  {
    table: "web_grants",
    staging: "web_grants_rebuild",
    createSql: `CREATE TABLE web_grants_rebuild (
      id              TEXT PRIMARY KEY,
      grant_hash      TEXT NOT NULL UNIQUE,
      registration_id TEXT NOT NULL REFERENCES mobile_registrations(host_id),
      admin           INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      revoked_at      INTEGER,
      revoked_reason  TEXT
    )`,
    columns: ["id", "grant_hash", "registration_id", "admin", "created_at", "revoked_at", "revoked_reason"],
    addedColumns: [],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_web_grants_registration ON web_grants(registration_id)",
    ],
    dropUniqueOn: "registration_id",
  },
];

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== null
  );
}

function indexExists(db: Database, index: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(index) !== null
  );
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

/** True when any UNIQUE index on `table` covers exactly `column` — the legacy
 *  single-row constraint (its SQLite auto-index is not named by us, so
 *  indexes are inspected rather than matched by name). */
function hasUniqueIndexOn(db: Database, table: string, column: string): boolean {
  const indexes = db.query<IndexListRow, []>(`PRAGMA index_list(${table})`).all();
  return indexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = db
      .query<{ name: string }, []>(`PRAGMA index_info(${index.name})`)
      .all()
      .map((c) => c.name);
    return columns.length === 1 && columns[0] === column;
  });
}

/** True when the live table cannot hold a reconnect yet: it still enforces the
 *  legacy UNIQUE column, is missing a column the target shape adds, or lacks
 *  one of the target indexes. */
function needsRebuild(db: Database, rebuild: TableRebuild): boolean {
  if (hasUniqueIndexOn(db, rebuild.table, rebuild.dropUniqueOn)) return true;
  const columns = columnsOf(db, rebuild.table);
  if (rebuild.addedColumns.some((column) => !columns.includes(column))) return true;
  return rebuild.indexes.some((index) => {
    const name = /INDEX IF NOT EXISTS (\S+)/.exec(index)?.[1];
    return name !== undefined && !indexExists(db, name);
  });
}

/** Rebuild one table into its LAMA-337 shape as a single transaction: on any
 *  failure the original table is untouched and the next boot retries. */
function rebuildTable(db: Database, rebuild: TableRebuild): void {
  const columnList = rebuild.columns.join(", ");
  db.run(`DROP TABLE IF EXISTS ${rebuild.staging}`);
  const rebuildTx = db.transaction(() => {
    db.run(rebuild.createSql);
    db.run(
      `INSERT INTO ${rebuild.staging} (${columnList})
         SELECT ${columnList} FROM ${rebuild.table}`,
    );
    db.run(`DROP TABLE ${rebuild.table}`);
    db.run(`ALTER TABLE ${rebuild.staging} RENAME TO ${rebuild.table}`);
    for (const index of rebuild.indexes) db.run(index);
  });
  rebuildTx();
}

/**
 * Rebuild the mobile credential tables that predate LAMA-337, preserving every
 * row. No-op for a table that is absent (a fresh database gets it from
 * SERVER_SCHEMA) or already in the target shape.
 */
export function migrateMobileReconnectTables(db: Database): void {
  for (const rebuild of REBUILDS) {
    if (!tableExists(db, rebuild.table)) continue;
    if (!needsRebuild(db, rebuild)) continue;
    rebuildTable(db, rebuild);
  }
}
