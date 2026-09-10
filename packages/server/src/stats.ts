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
import { resolveDestination, type StorageReport, type FolderSize } from "@lamasync/core";
import { BACKEND_SELECT, type BackendRow, getBackend, resolveFolderS3Config } from "./backends.ts";
import { decryptSecret } from "./crypto.ts";
import { withTempRcloneConfig } from "./temp-rclone-config.ts";
import type { Folder } from "@lamasync/core";

const REPORT_TTL_MS = 5 * 60 * 1000;
const FOLDER_TTL_MS = 15 * 60 * 1000;
const RCLONE_TIMEOUT = "10s";
/** Wall-clock cap on a single rclone invocation. `--timeout` bounds rclone's own
 *  transfer/idle waits, not a wedged process: without a hard kill a hung child
 *  would hold a refresh slot (and its folder's dedupe entry) for the lifetime of
 *  the process (LAMA-328 review finding 6). */
const RCLONE_KILL_MS = 15_000;
const RCLONE_SIGKILL_AFTER_MS = 2_000;
interface SizeMeasure {
  bytes: number;
  objectCount: number | null;
  error: string | null;
}

// Test seam (see __setSizeMeasurer below): when set, rcloneSize delegates to
// this measurer instead of spawning rclone. null restores the real path.
let sizeMeasurer: ((configText: string, target: string) => Promise<SizeMeasure>) | null = null;

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
const folderCache = new Map<string, CachedFolderSize>();

function fresh<T>(cached: Cached<T> | undefined, ttlMs: number, now: number): boolean {
  return cached !== undefined && now - cached.at < ttlMs;
}

// --- LAMA-328: stale-while-revalidate folder sizes --------------------------
//
// Folder size is the only folder-page measurement that spawns rclone (10s
// timeout per prefix). A page visit must never wait for it: any known value —
// in-memory first, else the persisted `size_history` row — is answered
// immediately, and a stale one triggers a bounded background refresh. Only an
// explicit `refresh=true` measures on the request itself.

/** A known size: the bytes plus when they were really measured. */
interface MeasuredFolderSize {
  folderId: string;
  bytes: number | null;
  objectCount: number | null;
  /** null when a measurement has been attempted and failed but no size was
   *  ever obtained — callers must never read that as a measurement time. */
  measuredAt: number | null;
}

/** One folder's last known size plus the freshness bookkeeping around it. */
interface CachedFolderSize {
  /** Last successfully measured value. `value.measuredAt` is the measurement
   *  time — callers are told that, never the time we happened to serve it. */
  value: MeasuredFolderSize;
  /** Last time we answered or attempted a measurement. Anchors the TTL so an
   *  unreachable backend is retried once per window, not once per page visit. */
  checkedAt: number;
  /** Error from the most recent attempt, if it failed. */
  error: string | null;
  /** A mutation invalidated these bytes: refresh before calling them current. */
  invalidated: boolean;
}

/**
 * Folders invalidated by a mutation, mapped to the time of the newest one. This
 * is deliberately separate from `folderCache`: an invalidation must survive a
 * server restart (or a folder nothing has read yet), and it must not be erased
 * by a measurement that had already started when it arrived.
 */
const invalidatedFolders = new Map<string, number>();

// Bounds on background refresh work, so repeated page visits cannot create an
// rclone process storm: at most one refresh per folder (dedupe), two overall,
// and one per backend (a single slow bucket cannot occupy every slot).
const REFRESH_CONCURRENCY = 2;
const REFRESH_CONCURRENCY_PER_BACKEND = 1;

interface RefreshWaiter {
  backendKey: string;
  start: () => void;
}

const refreshWaiters: RefreshWaiter[] = [];
const refreshScheduled = new Set<string>();
const refreshesInFlight = new Set<Promise<void>>();
let activeRefreshes = 0;
const activeRefreshesByBackend = new Map<string, number>();

function refreshSlotFree(backendKey: string): boolean {
  return (
    activeRefreshes < REFRESH_CONCURRENCY &&
    (activeRefreshesByBackend.get(backendKey) ?? 0) < REFRESH_CONCURRENCY_PER_BACKEND
  );
}

function takeRefreshSlot(backendKey: string): void {
  activeRefreshes += 1;
  activeRefreshesByBackend.set(backendKey, (activeRefreshesByBackend.get(backendKey) ?? 0) + 1);
}

function releaseRefreshSlot(backendKey: string): void {
  activeRefreshes -= 1;
  const remaining = (activeRefreshesByBackend.get(backendKey) ?? 0) - 1;
  if (remaining > 0) activeRefreshesByBackend.set(backendKey, remaining);
  else activeRefreshesByBackend.delete(backendKey);
  // Hand the freed capacity to the oldest waiter that can still use it.
  for (let i = 0; i < refreshWaiters.length; i += 1) {
    const waiter = refreshWaiters[i];
    if (!refreshSlotFree(waiter.backendKey)) continue;
    refreshWaiters.splice(i, 1);
    takeRefreshSlot(waiter.backendKey);
    waiter.start();
    return;
  }
}

function acquireRefreshSlot(backendKey: string): Promise<void> {
  if (refreshSlotFree(backendKey)) {
    takeRefreshSlot(backendKey);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    refreshWaiters.push({ backendKey, start: resolve });
  });
}

/**
 * Schedule one background measurement for `folder`. At most one runs per folder
 * at a time, and the semaphore above bounds the fleet-wide cost. Failures are
 * swallowed here on purpose: a background refresh must never surface as a
 * request error, and the next read reports what actually happened.
 */
function scheduleFolderRefresh(db: Database, folder: Folder): void {
  if (folder.backend !== "s3") return;
  if (refreshScheduled.has(folder.id)) return;
  refreshScheduled.add(folder.id);
  const backendKey = folder.backendId ?? "unassigned-backend";
  const task = (async () => {
    await acquireRefreshSlot(backendKey);
    try {
      await measureFolderSize(db, folder);
    } catch {
      // Deliberately ignored; see the doc comment above.
    } finally {
      releaseRefreshSlot(backendKey);
      refreshScheduled.delete(folder.id);
    }
  })();
  refreshesInFlight.add(task);
  void task.finally(() => refreshesInFlight.delete(task));
}

/**
 * The newest persisted successful measurement for a folder, or null when the
 * folder has never been measured. This is what makes a server restart cheap:
 * the in-memory cache is empty, but the bytes are already in `size_history`.
 */
function persistedFolderSize(db: Database, folderId: string): CachedFolderSize | null {
  const row = db
    .query<{ bytes: number; object_count: number | null; measured_at: number }, [string]>(
      `SELECT bytes, object_count, measured_at FROM size_history
        WHERE scope = 'folder' AND ref_id = ?
        ORDER BY measured_at DESC LIMIT 1`,
    )
    .get(folderId);
  if (!row) return null;
  return {
    value: {
      folderId,
      bytes: row.bytes,
      objectCount: row.object_count,
      measuredAt: row.measured_at,
    },
    // Anchor on the measurement itself: a measurement younger than the TTL is
    // served as fresh (no pointless refresh), an older one as stale.
    checkedAt: row.measured_at,
    error: null,
    invalidated: false,
  };
}

/** Project a cache entry onto the wire type, with explicit freshness metadata. */
function folderFreshness(
  entry: CachedFolderSize,
  now: number,
  refreshing: boolean,
): FolderSize {
  return {
    ...entry.value,
    error: entry.error,
    // "Not current" covers both reasons: the bytes aged past the TTL, or a
    // mutation invalidated them before the refresh landed.
    stale:
      entry.invalidated ||
      entry.value.measuredAt === null ||
      now - entry.value.measuredAt >= FOLDER_TTL_MS,
    // Any queued or running refresh for this folder is reported from every
    // read, so a polling caller does not conclude the work finished (LAMA-328
    // review finding 1: the warm-cache branch used to answer `false`).
    refreshing: refreshing || refreshScheduled.has(entry.value.folderId),
  };
}

/** The typed "not measurable on the server" answer for non-S3 folders. */
export function notMeasurableFolderSize(folderId: string): FolderSize {
  return {
    folderId,
    bytes: null,
    objectCount: null,
    error: "not measurable server-side",
    measuredAt: null,
    stale: false,
    refreshing: false,
  };
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

/** `rclone size --json <remote>:<bucket>/<prefix>` against a temp config, 10s timeout. */
async function rcloneSize(configText: string, target: string): Promise<SizeMeasure> {
  // Test seam: delegate to the injected measurer instead of spawning rclone.
  if (sizeMeasurer !== null) return sizeMeasurer(configText, target);

  // LAMA-226 P1-6: use the shared helper so the rclone config never sits
  // on disk past the call (private dir, 0600 perms, removed on both paths).
  return withTempRcloneConfig(configText, async (configPath) => {
    const proc = Bun.spawn(
      ["rclone", "size", "--json", target, "--config", configPath, "--timeout", RCLONE_TIMEOUT],
      { stdout: "pipe", stderr: "pipe" },
    );
    // A wedged rclone must never outlive this call: SIGTERM at the deadline,
    // then SIGKILL if it ignores that.
    const killTimer = setTimeout(() => proc.kill(), RCLONE_KILL_MS);
    const sigkillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone — `exited` resolves on its own.
      }
    }, RCLONE_KILL_MS + RCLONE_SIGKILL_AFTER_MS);
    let stdout: string;
    let stderr: string;
    let code: number;
    try {
      [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
    }
    if (code !== 0) {
      const detail = stderr.trim().split("\n").pop() ?? "rclone size failed";
      return { bytes: 0, objectCount: null, error: detail };
    }
    // `rclone size --json` prints a single object, e.g. {"bytes": 123, "count": 42}.
    // Default missing/wrong-typed fields to 0 (bytes) / null (count) rather than
    // fabricating a measurement; a throw here is caught by the fallback below.
    const parsed: { bytes?: unknown; count?: unknown } = JSON.parse(stdout);
    const bytes = typeof parsed.bytes === "number" && Number.isFinite(parsed.bytes) ? parsed.bytes : 0;
    const objectCount = typeof parsed.count === "number" && Number.isFinite(parsed.count) ? parsed.count : null;
    return { bytes, objectCount, error: null };
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
 * LAMA-304: the destination prefixes an S3 folder measures. Each assignment
 * contributes the prefix resolved for that host; restic-backed assignments
 * (restic_repository set) live in a restic repo, not the S3 prefix, so they
 * are skipped. De-duplicated in insertion order. A folder with no assignment
 * and no skip has zero measurable prefixes.
 */
export function folderDestinationPrefixes(db: Database, folder: Folder): string[] {
  const rows = db
    .query<
      { host_id: string; remote_name: string | null; destination: string | null; restic_repository: string | null },
      [string]
    >(
      "SELECT host_id, remote_name, destination, restic_repository FROM folder_assignments WHERE folder_id = ?",
    )
    .all(folder.id);
  const prefixes = new Set<string>();
  for (const row of rows) {
    // Restic-backed assignments are measured through the repository, not the
    // S3 prefix — skip them so we never measure a prefix with no S3 data.
    if (row.restic_repository !== null) continue;
    const prefix = resolveDestination(folder, {
      hostId: row.host_id,
      remoteName: row.remote_name,
      destination: row.destination,
      resticRepository: row.restic_repository,
      // restic_password is not fetched: every assignment we process has a
      // null restic_repository, so a restic password is irrelevant here.
      resticPassword: undefined,
    });
    prefixes.add(prefix);
  }
  return [...prefixes];
}

/**
 * Last-known size of a single folder's working set (LAMA-224/304), served
 * stale-while-revalidate (LAMA-328).
 *
 * Read order:
 *  1. a warm in-memory entry inside its TTL (unless `refresh`),
 *  2. any known value — memory, else the persisted `size_history` row — with a
 *     bounded background refresh scheduled when it is stale or invalidated,
 *  3. a measurement on the request, either because nothing is known yet or
 *     because the caller passed `refresh` (the explicit "Refresh sizes" path).
 *
 * Non-S3 folders are not measurable server-side: their working set lives on a
 * daemon host, so they return a typed null instead of measuring a path that
 * does not exist here (LAMA-224 P1-7), and never schedule a refresh.
 */
export async function getFolderSize(
  db: Database,
  folder: Folder,
  refresh = false,
): Promise<FolderSize> {
  return readFolderSize(db, folder, { refresh, allowMeasureOnRequest: true });
}

/**
 * Sizes for many folders in one non-blocking pass (LAMA-328): the bulk surface
 * the folder page and the storage donut use, so a page visit can never measure
 * N folders synchronously. Known values are served from memory or persisted
 * history; stale or never-measured folders come back with `refreshing: true`
 * while the bounded background scheduler does the work.
 *
 * With `refresh: true` (the explicit "Refresh sizes" action) every S3 folder is
 * re-measured in the background, including entries still inside their TTL, and
 * the returned entries say so — the response itself still returns immediately.
 */
export async function getFolderSizesBulk(
  db: Database,
  folders: Folder[],
  options: { refresh?: boolean } = {},
): Promise<Record<string, FolderSize>> {
  const out: Record<string, FolderSize> = {};
  for (const folder of folders) {
    const size = await readFolderSize(db, folder, {
      refresh: false,
      allowMeasureOnRequest: false,
    });
    if (options.refresh !== true || folder.backend !== "s3") {
      out[folder.id] = size;
      continue;
    }
    scheduleFolderRefresh(db, folder);
    out[folder.id] = { ...size, refreshing: true };
  }
  return out;
}

interface ReadFolderSizeOptions {
  /** Bypass every cached/persisted answer and measure on this call. */
  refresh: boolean;
  /** When false, an unknown folder is reported as refreshing, never measured
   *  on the request (bulk reads must stay fast on a cold fleet). */
  allowMeasureOnRequest: boolean;
}

async function readFolderSize(
  db: Database,
  folder: Folder,
  options: ReadFolderSizeOptions,
): Promise<FolderSize> {
  if (folder.backend !== "s3") return notMeasurableFolderSize(folder.id);
  const now = Date.now();
  const cached = folderCache.get(folder.id);

  if (
    !options.refresh &&
    cached !== undefined &&
    !cached.invalidated &&
    !invalidatedFolders.has(folder.id) &&
    now - cached.checkedAt < FOLDER_TTL_MS
  ) {
    return folderFreshness(cached, now, false);
  }

  if (!options.refresh) {
    const known = cached ?? persistedFolderSize(db, folder.id);
    if (known !== null) {
      // Serve what we have and refresh behind the request. `checkedAt` is the
      // TTL anchor — a persisted row younger than the TTL is genuinely current,
      // so it is served without a refresh — while `invalidated` marks bytes a
      // mutation has already made wrong.
      const invalidated = known.invalidated || invalidatedFolders.has(folder.id);
      const needsRefresh = invalidated || now - known.checkedAt >= FOLDER_TTL_MS;
      const entry: CachedFolderSize = { ...known, checkedAt: now, invalidated };
      folderCache.set(folder.id, entry);
      if (needsRefresh) scheduleFolderRefresh(db, folder);
      return folderFreshness(entry, now, needsRefresh);
    }
  }

  if (!options.allowMeasureOnRequest) {
    // Nothing known yet, but this is a bulk read: report an in-flight refresh
    // with no fabricated measurement instead of blocking on rclone.
    scheduleFolderRefresh(db, folder);
    return {
      folderId: folder.id,
      bytes: null,
      objectCount: null,
      error: null,
      measuredAt: null,
      stale: true,
      refreshing: true,
    };
  }

  return measureFolderSize(db, folder);
}

/**
 * The measurement itself. Shared by the blocking read and the background
 * refresh, and never throws: a failure keeps the last known bytes and reports
 * it through `error` rather than erasing a value we already published.
 */
async function measureFolderSize(db: Database, folder: Folder): Promise<FolderSize> {
  // Captured before the measurement: a mutation that lands while rclone runs
  // must keep the result marked as not current instead of being cleared by it.
  const startedAt = Date.now();
  const now = startedAt;
  const previous = folderCache.get(folder.id) ?? persistedFolderSize(db, folder.id);
  const measured = await measureS3Folder(db, folder);
  const keepPrevious =
    measured.error !== null && previous !== null && previous.value.bytes !== null;
  const value: MeasuredFolderSize = keepPrevious
    ? previous.value
    : {
        folderId: folder.id,
        bytes: measured.bytes,
        objectCount: measured.objectCount,
        // A failed attempt is not a measurement: only a success stamps a time.
        measuredAt: measured.error === null ? now : null,
      };
  // `>=` on purpose: an invalidation that lands in the same millisecond the
  // measurement started is treated as newer, which costs at most one extra
  // refresh and never reports post-mutation state as current.
  const invalidatedDuringMeasure = (invalidatedFolders.get(folder.id) ?? 0) >= startedAt;
  if (!invalidatedDuringMeasure) invalidatedFolders.delete(folder.id);
  const entry: CachedFolderSize = {
    value,
    checkedAt: now,
    error: measured.error,
    invalidated: invalidatedDuringMeasure,
  };
  folderCache.set(folder.id, entry);
  if (measured.error === null) recordSizeHistory(db, folder, { ...value, error: null });
  return folderFreshness(entry, now, false);
}

/**
 * Per-prefix S3 measurement (`rclone size --json` per destination prefix,
 * LAMA-304). All-or-nothing: any prefix failure yields an error rather than a
 * misleading partial sum.
 */
async function measureS3Folder(
  db: Database,
  folder: Folder,
): Promise<{ bytes: number | null; objectCount: number | null; error: string | null }> {
  const s3 = resolveFolderS3Config(db, folder);
  if (!s3) return { bytes: null, objectCount: null, error: "no resolvable S3 backend" };
  const backend = getBackend(db, s3.backendId);
  if (!backend) return { bytes: null, objectCount: null, error: "backend not found" };
  const prefixes = folderDestinationPrefixes(db, folder);
  if (prefixes.length === 0) {
    return { bytes: null, objectCount: null, error: "no resolvable destination prefix" };
  }
  let bytes = 0;
  let objectCount = 0;
  let anyCountNull = false;
  for (const prefix of prefixes) {
    const r = await rcloneSize(s3ConfigText(backend, s3.bucket), `stats:${s3.bucket}/${prefix}`);
    if (r.error !== null) return { bytes: null, objectCount: null, error: r.error };
    bytes += r.bytes;
    if (r.objectCount === null) anyCountNull = true;
    objectCount += r.objectCount ?? 0;
  }
  return { bytes, objectCount: anyCountNull ? null : objectCount, error: null };
}

/**
 * Mark a folder's known size not-current after a mutation (sync report, browse
 * write). The bytes stay available for an immediate non-blocking answer; the
 * next read schedules a refresh instead of making the page wait for one — which
 * is what the previous cache-drop did (LAMA-328).
 *
 * The timestamp is what lets a refresh that was already running when the
 * mutation landed stay marked as invalid, instead of overwriting it (see
 * `measureFolderSize`).
 */
export function invalidateFolderSize(folderId: string): void {
  invalidatedFolders.set(folderId, Date.now());
  const cached = folderCache.get(folderId);
  if (cached !== undefined) cached.invalidated = true;
}

// --- LAMA-269: size time series for the storage donut + growth sparkline ---

export interface SizeHistoryPoint {
  measuredAt: number;
  bytes: number | null;
}

/** LAMA-328: bounds for the history read (see `getStorageHistory`). */
export interface StorageHistoryOptions {
  /** Only return points measured within the last `days` days (default 90). */
  days?: number;
  /** "day" (default) keeps one point per backend per UTC day; "raw" keeps all. */
  granularity?: "day" | "raw";
}

const HISTORY_DEFAULT_DAYS = 90;

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
  // Sum the newest measurement of every folder that points at this backend.
  // `h.id` picks exactly one row per folder: a folder measured twice in the same
  // millisecond (a forced refresh overlapping a background one, LAMA-328 review
  // finding 5) must not be counted twice, and the `(ref_id, scope, measured_at)`
  // index makes each lookup a seek rather than a scan.
  const agg = db
    .query<{ bytes: number | null; objects: number | null }, [string]>(
      `SELECT SUM(h.bytes) AS bytes, SUM(h.object_count) AS objects
       FROM size_history h
       JOIN folders f ON f.id = h.ref_id
       WHERE h.scope = 'folder' AND f.backend_id = ?
         AND h.id = (
           SELECT id FROM size_history
           WHERE scope = 'folder' AND ref_id = h.ref_id
           ORDER BY measured_at DESC, id DESC LIMIT 1
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
 * backendId -> chronological points. Backends with no measured point in the
 * window are absent, so callers can render an explicit "not measured yet"
 * state.
 *
 * LAMA-328: the payload is bounded. Only `days` (default 90) of history is
 * returned, and `granularity: "day"` keeps the last measurement of each UTC day
 * per backend, so daily measurements cannot grow the response and the chart
 * work without limit. `granularity: "raw"` returns every point in the window.
 */
export function getStorageHistory(
  db: Database,
  options: StorageHistoryOptions = {},
): Record<string, SizeHistoryPoint[]> {
  const days = clampHistoryDays(options.days);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const raw = db
    .query<{ ref_id: string; measured_at: number; bytes: number | null }, [number]>(`
      SELECT ref_id, measured_at, bytes FROM size_history
       WHERE scope = 'backend' AND measured_at >= ?
       ORDER BY ref_id, measured_at ASC
    `)
    .all(since);
  const rows = options.granularity === "raw" ? raw : lastPointPerDay(raw);
  const out: Record<string, SizeHistoryPoint[]> = {};
  for (const r of rows) {
    const points = (out[r.ref_id] ??= []);
    // Two folders on one backend can be measured in the same millisecond; keep
    // one point rather than a duplicated step in the sparkline.
    if (points.length > 0 && points[points.length - 1].measuredAt === r.measured_at) continue;
    points.push({ measuredAt: r.measured_at, bytes: r.bytes });
  }
  return out;
}

const HISTORY_MIN_DAYS = 1;
const HISTORY_MAX_DAYS = 3650;

function clampHistoryDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return HISTORY_DEFAULT_DAYS;
  return Math.min(Math.max(Math.trunc(days), HISTORY_MIN_DAYS), HISTORY_MAX_DAYS);
}

/** Keep only the newest point of each UTC day, per backend. */
function lastPointPerDay(
  rows: Array<{ ref_id: string; measured_at: number; bytes: number | null }>,
): Array<{ ref_id: string; measured_at: number; bytes: number | null }> {
  const out: Array<{ ref_id: string; measured_at: number; bytes: number | null }> = [];
  let currentKey: string | null = null;
  for (const r of rows) {
    const key = `${r.ref_id}:${Math.floor(r.measured_at / 86_400_000)}`;
    if (key === currentKey) out[out.length - 1] = r;
    else out.push(r);
    currentKey = key;
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
  invalidatedFolders.clear();
  sizeMeasurer = null;
}

/**
 * Test seam (LAMA-328): current background-refresh occupancy, so a test can
 * assert deduplication and the concurrency bound instead of guessing at timings.
 */
export function __refreshState(): { active: number; queued: number; scheduled: number } {
  return { active: activeRefreshes, queued: refreshWaiters.length, scheduled: refreshScheduled.size };
}

/**
 * Test seam (LAMA-328): wait for every scheduled background refresh to finish.
 * Call it before closing a test database or resetting the caches, otherwise a
 * refresh can still be using them.
 */
export async function __drainFolderRefreshes(): Promise<void> {
  while (refreshesInFlight.size > 0) {
    await Promise.all([...refreshesInFlight]);
  }
}
/**
 * Test seam: substitute the rclone measurement. When `measurer` is non-null,
 * `rcloneSize` delegates to it instead of spawning rclone; pass `null` to
 * restore the real implementation. Used by the unit tests to avoid needing
 * a live rclone/bucket for folder-size measurements.
 */
export function __setSizeMeasurer(
  measurer: ((configText: string, target: string) => Promise<SizeMeasure>) | null,
): void {
  sizeMeasurer = measurer;
}
