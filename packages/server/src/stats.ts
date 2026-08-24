// LAMA-224: storage statistics engine. Every measurement is lazy, cached
// server-side, and never allowed to fail the whole report — a backend that
// is unreachable or misconfigured contributes an entry with `error` set.
//
// Local roots and restic aggregates are cheap (du / DB rows). S3 backends
// spawn `rclone size` against a temp config derived from the Backend row —
// the same plumbing the rclone config generator uses — with a 10s timeout.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StorageReport, FolderSize } from "@lamasync/core";
import { BACKEND_SELECT, type BackendRow, getBackend, resolveFolderS3Config } from "./backends.ts";
import { decryptSecret } from "./crypto.ts";
import { withTempRcloneConfig } from "./temp-rclone-config.ts";
import type { Folder } from "@lamasync/core";

const REPORT_TTL_MS = 5 * 60 * 1000;
const FOLDER_TTL_MS = 15 * 60 * 1000;
const RCLONE_TIMEOUT = "10s";

function dataDir(): string {
  return process.env.LAMASYNC_DATA_DIR ?? "/data";
}

function backupDir(): string {
  return process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
}

interface Cached<T> {
  value: T;
  at: number;
}

const reportCache = new Map<string, Cached<StorageReport>>();
const folderCache = new Map<string, Cached<FolderSize>>();

function fresh<T>(cached: Cached<T> | undefined, ttlMs: number, now: number): boolean {
  return cached !== undefined && now - cached.at < ttlMs;
}

async function duBytes(path: string): Promise<{ bytes: number; error: string | null }> {
  try {
    if (!existsSync(path)) return { bytes: 0, error: null };
    const proc = Bun.spawn(["du", "-sb", path], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { bytes: 0, error: stderr.trim() || "du failed" };
    const match = /^(\d+)\s+/.exec(stdout.trim());
    const bytes = match ? Number.parseInt(match[1], 10) : NaN;
    return { bytes: Number.isFinite(bytes) ? bytes : 0, error: null };
  } catch (err) {
    return { bytes: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `rclone size <remote>:<bucket>/<prefix>` against a temp config, 10s timeout. */
async function rcloneSize(configText: string, remoteBucket: string): Promise<{
  bytes: number;
  objectCount: number | null;
  error: string | null;
}> {
  // LAMA-226 P1-6: use the shared helper so the rclone config never sits
  // on disk past the call (private dir, 0600 perms, removed on both paths).
  return withTempRcloneConfig(configText, async (configPath) => {
    const proc = Bun.spawn(
      ["rclone", "size", remoteBucket, "--config", configPath, "--timeout", RCLONE_TIMEOUT],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const detail = stderr.trim().split("\n").pop() ?? "rclone size failed";
      return { bytes: 0, objectCount: null, error: detail };
    }
    // rclone size prints e.g. "Total objects: 42\nTotal size: 1.234 GiB (1325346 Byte)"
    const objects = /Total objects:\s*(\d+)/.exec(stdout);
    const bytes = /\((\d+) Byte\)/.exec(stdout);
    return {
      bytes: bytes ? Number.parseInt(bytes[1], 10) : 0,
      objectCount: objects ? Number.parseInt(objects[1], 10) : null,
      error: null,
    };
  }).catch((err) => ({
    bytes: 0,
    objectCount: null,
    error: err instanceof Error ? err.message : String(err),
  }));
}

function s3ConfigText(backend: BackendRow, bucket: string): string {
  const secret = decryptSecret(backend.s3_secret_key_enc) ?? "";
  return [
    "[stats]",
    "type = s3",
    `provider = ${backend.s3_provider === "aws" ? "AWS" : "Other"}`,
    "env_auth = false",
    `access_key_id = ${backend.s3_access_key_id ?? ""}`,
    `secret_access_key = ${secret}`,
    `endpoint = ${backend.s3_endpoint ?? ""}`,
    ...(backend.s3_region ? [`region = ${backend.s3_region}`] : []),
  ].join("\n");
}

/** Compute the full report. `db` must be the live server DB. */
export async function computeStorageReport(db: Database): Promise<StorageReport> {
  const generatedAt = Date.now();
  const entries: StorageReport["backends"] = [];

  // Local roots: data dir + backup dir.
  const [dataSize, backupSize] = await Promise.all([
    duBytes(dataDir()),
    duBytes(backupDir()),
  ]);
  const localBytes = (dataSize.bytes || 0) + (backupSize.bytes || 0);
  entries.push({
    backendId: null,
    label: `Local (${dataDir()} + ${backupDir()})`,
    kind: "local",
    bytes: localBytes,
    objectCount: null,
    error: dataSize.error ?? backupSize.error,
  });

  // S3: one entry per backend (credentials stored once, LAMA-222). The
  // bucket is taken from the first folder that references this backend.
  // A backend with no referencing folder has no resolvable bucket — we
  // omit the entry rather than fabricate a name (LAMA-224 P1-7).
  const backends = db.query<BackendRow, []>(BACKEND_SELECT).all();
  for (const backend of backends) {
    if (backend.kind !== "s3") continue;
    const bucketRow = db
      .query<{ s3_bucket: string | null }, [string]>(
        "SELECT s3_bucket FROM folders WHERE backend_id = ? AND s3_bucket IS NOT NULL LIMIT 1",
      )
      .get(backend.id);
    const bucket = bucketRow?.s3_bucket?.trim();
    if (!bucket) continue;
    const result = await rcloneSize(s3ConfigText(backend, bucket), `stats:${bucket}`);
    entries.push({
      backendId: backend.id,
      label: `S3: ${backend.name} (${backend.s3_endpoint ?? ""})`,
      kind: "s3",
      bytes: result.bytes,
      objectCount: result.objectCount,
      error: result.error,
    });
  }

  // Restic: aggregate snapshot metadata straight from the DB (cheap, no
  // external restic needed — the sizes are already recorded at snapshot
  // time by the daemon).
  const restic = db
    .query<{ c: number; sum: number | null }, []>(
      "SELECT COUNT(*) AS c, SUM(size_bytes) AS sum FROM restic_snapshots",
    )
    .get() ?? { c: 0, sum: null };
  const resticBytes = restic.sum ?? 0;
  entries.push({
    backendId: null,
    label: `Restic (${restic.c} snapshot${restic.c === 1 ? "" : "s"})`,
    kind: "restic",
    bytes: resticBytes,
    objectCount: restic.c,
    error: null,
  });

  // Total: sum of non-error entries, minus double-counted local (already
  // the sum of data+backups) — S3 and restic entries are distinct so a plain
  // sum is correct.
  const totalBytes = entries.reduce((acc, e) => (e.error ? acc : acc + e.bytes), 0);
  return { generatedAt, totalBytes, backends: entries };
}

/** Cached report; pass `refresh` to bypass the 5-minute TTL. */
export async function getStorageReport(
  db: Database,
  refresh = false,
): Promise<StorageReport> {
  const now = Date.now();
  const cached = reportCache.get("storage");
  if (!refresh && fresh(cached, REPORT_TTL_MS, now)) return cached!.value;
  const value = await computeStorageReport(db);
  reportCache.set("storage", { value, at: now });
  return value;
}

/** Invalidate the cached report after a sync/backup/dotfile operation. */
export function invalidateStorageReport(): void {
  reportCache.delete("storage");
}

/**
 * Last-known size of a single folder's working set. S3 folders measure
 * the bucket via `rclone size`; non-S3 folders are NOT measurable server-
 * side (the working set lives on the daemon host). LAMA-224 P1-7: callers
 * (the route layer) return a typed `{bytes:null, error:"not measurable
 * server-side"}` for non-S3 folders instead of measuring a path that does
 * not exist on the server.
 */
export async function getFolderSize(
  db: Database,
  folder: Folder,
  refresh = false,
): Promise<FolderSize> {
  const now = Date.now();
  const cached = folderCache.get(folder.id);
  if (!refresh && fresh(cached, FOLDER_TTL_MS, now)) return cached!.value;

  const base: FolderSize = {
    folderId: folder.id,
    bytes: 0,
    objectCount: null,
    error: null,
    measuredAt: now,
  };

  let result: { bytes: number | null; objectCount: number | null; error: string | null };
  if (folder.backend === "s3") {
    const s3 = resolveFolderS3Config(db, folder);
    if (!s3) {
      result = { bytes: null, objectCount: null, error: "no resolvable S3 backend" };
    } else {
      const backend = getBackend(db, s3.backendId);
      if (!backend) {
        result = { bytes: null, objectCount: null, error: "backend not found" };
      } else {
        // Bucket-level measurement (`remote:bucket`), not prefix-level:
        // folders sharing a bucket each report the full bucket size.
        result = await rcloneSize(
          s3ConfigText(backend, s3.bucket),
          `stats:${s3.bucket}`,
        );
      }
    }
  } else {
    // Non-S3: the working set lives on the daemon host. Return a typed
    // null (the caller surfaces it on the Folders page as "n/a").
    result = { bytes: null, objectCount: null, error: "not measurable server-side" };
  }

  const value: FolderSize = { ...base, ...result, measuredAt: now };
  folderCache.set(folder.id, { value, at: now });
  recordSizeHistory(db, folder, value);
  return value;
}

/** Invalidate a folder's cached size (e.g. after a sync report). */
export function invalidateFolderSize(folderId: string): void {
  folderCache.delete(folderId);
}

// --- LAMA-269: size time series for the storage donut + growth sparkline ---

export interface SizeHistoryPoint {
  measuredAt: number;
  bytes: number | null;
}

/**
 * Persist a measured folder size into `size_history`. Only measured sizes
 * (bytes != null) are stored; non-S3 folders return null and are skipped so
 * the sparkline never plots a fake zero. Alongside the folder-scoped row we
 * keep a backend-scoped aggregate so the web can plot a destination's total
 * growth directly instead of re-aggregating per-folder history per request.
 */
export function recordSizeHistory(
  db: Database,
  folder: Folder,
  size: FolderSize,
): void {
  // Only persist genuinely measured sizes. A failed measurement (error
  // set, or bytes null because the backend isn't measurable server-side)
  // must never create a misleading zero point in the sparkline.
  if (size.error !== null || size.bytes === null) return;
  const measuredAt = size.measuredAt ?? Date.now();
  db.run(
    "INSERT INTO size_history (scope, ref_id, bytes, object_count, measured_at) VALUES (?, ?, ?, ?, ?)",
    ["folder", folder.id, size.bytes, size.objectCount ?? null, measuredAt],
  );
  const backendId = folder.backendId;
  if (!backendId) return;
  // Sum the latest measured size of every folder that points at this backend.
  const agg = db
    .query<{ bytes: number | null; objects: number | null }, [string]>(
      `SELECT SUM(h.bytes) AS bytes, SUM(h.object_count) AS objects
       FROM size_history h
       JOIN folders f ON f.id = h.ref_id
       WHERE h.scope = 'folder' AND f.backend_id = ?
         AND h.measured_at = (
           SELECT MAX(measured_at) FROM size_history
           WHERE scope = 'folder' AND ref_id = h.ref_id
         )`,
    )
    .get(backendId);
  db.run(
    "INSERT INTO size_history (scope, ref_id, bytes, object_count, measured_at) VALUES (?, ?, ?, ?, ?)",
    ["backend", backendId, agg?.bytes ?? 0, agg?.objects ?? 0, measuredAt],
  );
}

/**
 * Per-backend size time series for the growth sparkline. Returns a map of
 * backendId -> chronological points. Backends with no measured point are
 * absent, so callers can render an explicit "not measured yet" state.
 */
export function getStorageHistory(
  db: Database,
): Record<string, SizeHistoryPoint[]> {
  const rows = db
    .query<{ ref_id: string; measured_at: number; bytes: number | null }, []>(
      "SELECT ref_id, measured_at, bytes FROM size_history WHERE scope = 'backend' ORDER BY ref_id, measured_at ASC",
    )
    .all();
  const out: Record<string, SizeHistoryPoint[]> = {};
  for (const r of rows) {
    (out[r.ref_id] ??= []).push({ measuredAt: r.measured_at, bytes: r.bytes });
  }
  return out;
}

// Re-export for tests.
export function __folderCacheSize(): number {
  return folderCache.size;
}

/** Test seam: drop all cached measurements between tests. */
export function __resetStatsCaches(): void {
  reportCache.clear();
  folderCache.clear();
}
