// LAMA-222: reusable backend domain helpers. `Backend` rows live in the
// `backends` table; folders reference them via `folders.backend_id`.
// Secrets are encrypted at rest (see crypto.ts) — the plaintext is only
// decrypted for internal consumers (rclone config generation, Data
// Browser, storage stats) and never crosses the API boundary.

import type { Database } from "bun:sqlite";
import {
  type Backend,
  type BackendKind,
  type LocalFolderConfig,
  type ResticBackendConfig,
  type S3FolderConfig,
  type S3Provider,
} from "@lamasync/core";
import { decryptSecret, encryptSecret } from "./crypto.ts";

export interface BackendRow {
  id: string;
  name: string;
  kind: string;
  s3_provider: string | null;
  s3_endpoint: string | null;
  s3_region: string | null;
  s3_access_key_id: string | null;
  s3_secret_key_enc: string | null;
  local_path: string | null;
  restic_repository: string | null;
  restic_password_enc: string | null;
  created_at: number;
}

export const BACKEND_SELECT =
  "SELECT id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, local_path, restic_repository, restic_password_enc, created_at FROM backends";

export function isBackendKind(value: string | null): value is BackendKind {
  return value === "s3" || value === "local" || value === "nfs" || value === "restic";
}

export function isS3Provider(value: string | null): value is S3Provider {
  return value === "exoscale" || value === "aws" || value === "other";
}

/** Map a backends row to the wire shape. Secrets never leave the server:
 *  `hasSecret` reports whether one is stored; the ciphertext stays local. */
export function rowToBackend(row: BackendRow): Backend {
  return {
    id: row.id,
    name: row.name,
    kind: isBackendKind(row.kind) ? row.kind : "s3",
    s3Provider: isS3Provider(row.s3_provider) ? row.s3_provider : "other",
    s3Endpoint: row.s3_endpoint,
    s3Region: row.s3_region,
    s3AccessKeyId: row.s3_access_key_id,
    hasSecret: row.s3_secret_key_enc !== null && row.s3_secret_key_enc !== "",
    localPath: row.local_path,
    resticRepository: row.restic_repository,
    hasResticPassword:
      row.restic_password_enc !== null && row.restic_password_enc !== "",
    createdAt: row.created_at,
  };
}

export function getBackend(db: Database, backendId: string): BackendRow | null {
  return db
    .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
    .get(backendId);
}

/**
 * Resolve a folder's S3 settings from its backendId (LAMA-222). Returns
 * null when the folder is not S3-typed, has no backend reference, or the
 * referenced backend is missing/incomplete. The stored secret is decrypted
 * here; callers must never log or return it.
 */
export function resolveFolderS3Config(
  db: Database,
  folder: { id: string; backend?: string | null; backendId?: string | null; s3Bucket?: string | null },
): S3FolderConfig | null {
  if (folder.backend !== "s3" || !folder.backendId) return null;
  const backend = getBackend(db, folder.backendId);
  if (!backend) return null;
  const endpoint = (backend.s3_endpoint ?? "").trim();
  const bucket = (folder.s3Bucket ?? "").trim();
  const accessKeyId = (backend.s3_access_key_id ?? "").trim();
  const secretKey = decryptSecret(backend.s3_secret_key_enc) ?? "";
  if (!endpoint || !bucket || !accessKeyId || !secretKey) return null;
  return {
    folderId: folder.id,
    backendId: backend.id,
    provider: isS3Provider(backend.s3_provider) ? backend.s3_provider : "other",
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey: secretKey,
    region: (backend.s3_region ?? "").trim() || null,
  };
}

/** Persist (or replace) a backend's secret, encrypted at rest. */
export function setBackendSecret(db: Database, backendId: string, plaintext: string): void {
  db.run("UPDATE backends SET s3_secret_key_enc = ? WHERE id = ?", [
    encryptSecret(plaintext),
    backendId,
  ]);
}

/** Persist (or replace) a restic backend's password, encrypted at rest. */
export function setBackendResticPassword(
  db: Database,
  backendId: string,
  plaintext: string,
): void {
  db.run("UPDATE backends SET restic_password_enc = ? WHERE id = ?", [
    encryptSecret(plaintext),
    backendId,
  ]);
}

/**
 * Resolve a folder's local/nfs settings from its backendId. Returns null
 * when the folder isn't local/nfs-typed, has no backend reference, or the
 * referenced backend is missing or lacks a path. The resolved path is an
 * absolute server-side directory (rclone type = local).
 */
export function resolveFolderLocalConfig(
  db: Database,
  folder: {
    id: string;
    backend?: string | null;
    backendId?: string | null;
  },
): LocalFolderConfig | null {
  if (folder.backend !== "local" && folder.backend !== "nfs") return null;
  if (!folder.backendId) return null;
  const backend = getBackend(db, folder.backendId);
  if (!backend) return null;
  const localPath = (backend.local_path ?? "").trim();
  if (localPath === "") return null;
  return {
    folderId: folder.id,
    backendId: backend.id,
    localPath,
  };
}

/**
 * Resolve a folder's restic defaults from its restic-kind backend. The
 * per-assignment resticRepository/resticPassword overrides keep working;
 * this is the default when the assignment doesn't override. The password
 * is decrypted here — callers must never log or return it.
 */
export function resolveFolderResticConfig(
  db: Database,
  folder: {
    id: string;
    backend?: string | null;
    backendId?: string | null;
  },
): ResticBackendConfig | null {
  if (folder.backend !== "restic" || !folder.backendId) return null;
  const backend = getBackend(db, folder.backendId);
  if (!backend) return null;
  const repository = (backend.restic_repository ?? "").trim();
  const password = decryptSecret(backend.restic_password_enc);
  if (repository === "" || !password) return null;
  return {
    backendId: backend.id,
    repository,
    password,
  };
}

/**
 * Outcome of the legacy s3_* → backends lift:
 * - "clean": nothing (left) to lift — safe to drop the legacy columns.
 * - "lifted": rows were migrated in this run — safe to drop.
 * - "failed": an error aborted the lift — the legacy columns MUST be kept;
 *   they still hold the only copy of the credentials (P0-3).
 */
export type LegacyLiftResult = "clean" | "lifted" | "failed";

/**
 * LAMA-222 data migration: lift legacy per-folder s3_* values into
 * `backends` rows (one per folder that has S3 data) and point the folder's
 * backend_id at the new row. Runs BEFORE initDb is allowed to drop the
 * legacy columns (see LEGACY_S3_DROP_MIGRATIONS). The whole lift is a
 * single transaction: a mid-loop failure rolls everything back and returns
 * "failed" so the caller keeps the legacy columns and retries on next boot.
 * Convergent: skips when the legacy column is already gone, and skips
 * folders that already point at a backend (e.g. lifted by an earlier,
 * pre-transactional run). The backend name is derived from the folder name
 * and uniquified against existing backends.
 */
export function migrateLegacyS3FoldersToBackends(db: Database): LegacyLiftResult {
  try {
    const hasColumn = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM pragma_table_info('folders') WHERE name = 's3_endpoint'",
      )
      .get();
    if (!hasColumn || hasColumn.c === 0) return "clean";

    // The folders table may still be missing backend_id (the ADD COLUMN in
    // MIGRATIONS runs AFTER this lift, in initDb). Add it here so the
    // UPDATE below can point folders at their lifted backend.
    try {
      db.run("ALTER TABLE folders ADD COLUMN backend_id TEXT");
    } catch {
      // column already exists
    }

    // Folders already pointing at a backend were lifted by an earlier run
    // (or created post-LAMA-222) — never re-lift them.
    const rows = db
      .query<
        {
          id: string;
          name: string;
          s3_provider: string | null;
          s3_endpoint: string | null;
          s3_bucket: string | null;
          s3_access_key_id: string | null;
          s3_secret_access_key: string | null;
          s3_region: string | null;
        },
        []
      >(
        "SELECT id, name, s3_provider, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region FROM folders WHERE s3_endpoint IS NOT NULL AND s3_endpoint != '' AND (backend_id IS NULL OR backend_id = '')",
      )
      .all();
    if (rows.length === 0) return "clean";

    const taken = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM backends")
        .all()
        .map((r) => r.name),
    );

    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const backendId = crypto.randomUUID();
        let base = `${row.name} (S3)`;
        let name = base;
        let n = 2;
        while (taken.has(name)) {
          name = `${base} ${n}`;
          n += 1;
        }
        taken.add(name);
        const secret = row.s3_secret_access_key ?? "";
        db.run(
          `INSERT INTO backends
             (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
           VALUES (?, ?, 's3', ?, ?, ?, ?, ?, ?)`,
          [
            backendId,
            name,
            row.s3_provider ?? "other",
            (row.s3_endpoint ?? "").trim(),
            row.s3_region,
            (row.s3_access_key_id ?? "").trim(),
            secret === "" ? null : encryptSecret(secret),
            Date.now(),
          ],
        );
        db.run("UPDATE folders SET backend = 's3', backend_id = ? WHERE id = ?", [
          backendId,
          row.id,
        ]);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(
      `[migrate] lifted ${rows.length} legacy S3 folder(s) into backends (LAMA-222)`,
    );
    return "lifted";
  } catch (error) {
    console.error(
      `[migrate] legacy S3 → backends lift failed (legacy s3_* columns preserved): ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}
