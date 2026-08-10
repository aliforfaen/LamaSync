// LAMA-226: Data Browser write-operation engine. Each operation runs as a
// `browse_job` row: created pending, marked running while rclone executes,
// and updated on every completed entry (progress_bytes/total_bytes count
// entries). Terminal jobs write an operation_log row for the audit trail.
//
// Concurrency guard: one in-memory + DB-backed "destination busy" check so
// two operators can't write to the same target simultaneously.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  BrowseJob,
  BrowseJobOperation,
  BrowseRef,
  Folder,
  S3FolderConfig,
} from "@lamasync/core";
import { broadcast } from "./ws.ts";
import { resolveFolderS3Config, getBackend } from "./backends.ts";
import { decryptSecret } from "./crypto.ts";
import { invalidateFolderSize, invalidateStorageReport } from "./stats.ts";
import { resolveBrowsePath, statEntry, validateBrowseInput } from "./browse-paths.ts";
import { listS3Objects } from "./s3-list.ts";
import {
  buildRcloneArgv,
  buildRcloneConfig,
  destKey,
  isContainedLocalMove,
  isSafeS3IntraFolderMove,
  refLabel,
  remotePath,
  type BuildArgvInput,
} from "./browse-rclone.ts";
import { withTempRcloneConfig } from "./temp-rclone-config.ts";

export interface BrowseJobRow {
  id: string;
  operation: string;
  source: string;
  destination: string;
  status: string;
  error: string | null;
  progress_bytes: number | null;
  total_bytes: number | null;
  created_at: number;
  updated_at: number;
}

const JOB_SELECT =
  "SELECT id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at FROM browse_jobs";

/**
 * In-memory mirrors of the DB-backed concurrency guard. The DB row is the
 * source of truth for "busy" checks across server restarts; this mirror
 * just avoids a SELECT on every request while the server is up.
 *
 * The keys are `destKey(ref)` (canonical) for destination contention and
 * `srcKey(ref, names)` for source contention — both prevent two writes
 * from racing on the same entry.
 */
const activeDestinations = new Set<string>();
const activeSources = new Set<string>();

export function __resetBrowseJobsForTests(): void {
  activeDestinations.clear();
  activeSources.clear();
}

function jobStatus(value: string): BrowseJob["status"] {
  switch (value) {
    case "pending":
    case "running":
    case "done":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "failed";
  }
}

function jobOperation(value: string): BrowseJobOperation | null {
  switch (value) {
    case "copy":
    case "move":
    case "upload":
    case "rename":
    case "mkdir":
    case "delete":
      return value;
    default:
      return null;
  }
}

function rowToJob(row: BrowseJobRow): BrowseJob {
  const operation = jobOperation(row.operation);
  if (operation === null) {
    throw new Error(`browse_jobs row ${row.id} has unknown operation '${row.operation}'`);
  }
  return {
    id: row.id,
    operation,
    source: row.source,
    destination: row.destination,
    status: jobStatus(row.status),
    error: row.error,
    progressBytes: row.progress_bytes,
    totalBytes: row.total_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function writeJob(db: Database, job: BrowseJob): void {
  try {
    db.run(
      `UPDATE browse_jobs SET status = ?, error = ?, progress_bytes = ?, total_bytes = ?, updated_at = ? WHERE id = ?`,
      [
        job.status,
        job.error,
        job.progressBytes,
        job.totalBytes,
        job.updatedAt,
        job.id,
      ],
    );
  } catch (error) {
    // A job may outlive its database handle (test teardown, server restart
    // mid-operation). The status update is best-effort — never throw into
    // the async executor.
    console.error(`[browse-jobs] status update failed: ${String(error)}`);
  }
}

function emit(db: Database, job: BrowseJob): void {
  broadcast({ kind: "browse_job", job });
}

/**
 * Insert a terminal "failed" browse_jobs row and broadcast it. Used by the
 * busy-guard short-circuit paths so every API call (even an immediately-
 * rejected one) leaves a row the UI can list. Returns the row that was
 * inserted.
 */
function insertFailedJob(
  db: Database,
  op: BrowseJobOperation,
  source: string,
  destination: string,
  error: string,
): BrowseJob {
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: op,
    source,
    destination,
    status: "failed",
    error,
    progressBytes: null,
    totalBytes: null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'failed', ?, NULL, NULL, ?, ?)`,
    [job.id, op, source, destination, error, now, now],
  );
  emit(db, job);
  return job;
}

function appendOperationLog(
  db: Database,
  job: BrowseJob,
  hostId: string,
): void {
  try {
    const status = job.status === "done" ? "success" : "failed";
    const summary =
      job.status === "done"
        ? `${job.operation} ${job.source} → ${job.destination}`
        : `${job.operation} failed: ${job.error ?? "unknown error"}`;
    db.run(
      `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary)
       VALUES (?, ?, NULL, ?, ?, ?)`,
      [Date.now(), hostId, `browse_${job.operation}`, status, summary],
    );
  } catch (error) {
    console.error(`[browse-jobs] operation_log append failed: ${String(error)}`);
  }
}

/** Spawn rclone and wait; returns stdout/stderr/code. Throws only on spawn failure. */
async function runRclone(
  argv: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Local rclone remotes resolve relative paths against the spawn cwd; the
  // browse operations live under $LAMASYNC_BACKUP_DIR. Default to that
  // root so call sites can pass `{}` and still get a sensible cwd.
  const finalOpts = opts.cwd !== undefined ? opts : { ...opts, cwd: process.env.LAMASYNC_BACKUP_DIR ?? "/backups" };
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", ...finalOpts });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * Binary variant of runRclone for the download path: `rclone cat` emits raw
 * bytes and `Response.text()` would corrupt non-UTF8 files, so the stdout
 * is captured as a Buffer here.
 */
async function runRcloneBinary(
  argv: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const finalOpts = opts.cwd !== undefined ? opts : { ...opts, cwd: process.env.LAMASYNC_BACKUP_DIR ?? "/backups" };
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", ...finalOpts });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: Buffer.from(stdout), stderr, code };
}

interface ResolvedFolder {
  folder: Folder;
  bucket: string;
  provider: "aws" | "other";
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string | null;
}

function resolveS3(db: Database, ref: BrowseRef): ResolvedFolder {
  if (ref.kind !== "s3") {
    throw new Error("resolveS3 called on non-s3 ref");
  }
  if (!ref.folderId) throw new Error("s3 ref requires folderId");
  const row = db
    .query<
      {
        id: string;
        name: string;
        backend: string | null;
        backend_id: string | null;
        s3_bucket: string | null;
      },
      [string]
    >(
      "SELECT id, name, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
    )
    .get(ref.folderId);
  if (!row) throw new Error(`folder ${ref.folderId} not found`);
  if (row.backend !== "s3" || !row.backend_id) {
    throw new Error(`folder ${ref.folderId} is not an S3 folder`);
  }
  const folder: Folder = {
    id: row.id,
    name: row.name,
    type: "backup",
    backend: "s3",
    backendId: row.backend_id,
    s3Bucket: row.s3_bucket,
  };
  const s3 = resolveFolderS3Config(db, folder);
  if (!s3) throw new Error(`folder ${row.id} has no resolvable S3 backend`);
  const backend = getBackend(db, s3.backendId);
  if (!backend) throw new Error(`backend ${s3.backendId} not found`);
  const secret = decryptSecret(backend.s3_secret_key_enc) ?? "";
  if (!s3.bucket) throw new Error(`folder ${row.id} has no S3 bucket configured`);
  return {
    folder,
    bucket: s3.bucket,
    provider: s3.provider === "aws" ? "aws" : "other",
    endpoint: s3.endpoint,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: secret,
    region: s3.region,
  };
}

function assertSafePath(path: string, name: string): void {
  // Root path ("") must not produce a leading slash — validateBrowseInput
  // rejects absolute paths, so "/name" would falsely fail.
  const combined = path === "" ? name : `${path}/${name}`;
  if (!validateBrowseInput(combined)) {
    throw new Error(`unsafe path for ${name}`);
  }
}

/**
 * LAMA-226 P1-9: rclone stderr can embed endpoint/bucket/host details.
 * Log it server-side; the job error (readable back via GET /browse/jobs)
 * gets a generic message — same scrubbing the route layer applies.
 */
function rcloneFailure(op: string, result: { code: number; stderr: string }): Error {
  console.error(`[browse-jobs] rclone ${op} failed (${result.code}): ${result.stderr.trim()}`);
  return new Error(`rclone ${op} failed (${result.code})`);
}

async function runCopy(
  db: Database,
  job: BrowseJob,
  src: BrowseRef,
  dst: BrowseRef,
  names: string[],
  resolved: {
    srcBucket: string | null;
    dstBucket: string | null;
  },
): Promise<void> {
  const config = buildJobConfig(db, src, dst);
  // Same-folder s3 configs carry only a `[src]` section (see buildJobConfig)
  // — the destination argv must reference `src:` there, `dst:` otherwise.
  const sameS3Folder =
    src.kind === "s3" && dst.kind === "s3" && src.folderId === dst.folderId;
  const dstRemote = sameS3Folder ? "src" : "dst";
  let completed = 0;
  await withTempRcloneConfig(config, async (configPath) => {
    for (const name of names) {
      assertSafePath(src.path, name);
      assertSafePath(dst.path, name);
      // `copyto` handles both files and directories (recursive for dirs) and
      // creates the destination path — uniform per-entry copy.
      const argvInput: BuildArgvInput = {
        operation: "copyto",
        configPath,
        srcRemote: "src",
        srcPath: remotePath(src, name, resolved.srcBucket ?? undefined),
        dstRemote,
        dstPath: remotePath(dst, name, resolved.dstBucket ?? undefined),
        timeout: "30s",
      };
      const result = await runRclone(buildRcloneArgv(argvInput));
      if (result.code !== 0) {
        throw rcloneFailure("copy", result);
      }
      completed += 1;
      job.progressBytes = completed;
      job.totalBytes = names.length;
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
    }
  });
}

async function deleteSource(
  db: Database,
  src: BrowseRef,
  names: string[],
  srcBucket: string | null,
): Promise<void> {
  // The local branch is a server-side rm -rf; only the source's backup-root
  // subtree matters — no rclone config required.
  if (src.kind === "local") {
    const cwd = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
    for (const name of names) {
      const target = join(cwd, src.path, name);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    }
    return;
  }

  // S3 source: `rclone delete <path> --rmdirs` against the same per-job
  // config used for the copy step. The bucket is always set for s3 (or
  // we'd have rejected the ref earlier).
  if (!srcBucket) throw new Error("s3 source missing resolved bucket");
  const config = buildJobConfig(db, src, src);
  await withTempRcloneConfig(config, async (configPath) => {
    for (const name of names) {
      const argvInput: BuildArgvInput = {
        operation: "delete",
        configPath,
        srcRemote: "src",
        srcPath: remotePath(src, name, srcBucket),
        timeout: "30s",
        rmdirs: true,
      };
      const result = await runRclone(buildRcloneArgv(argvInput));
      if (result.code !== 0) {
        throw rcloneFailure("delete", result);
      }
    }
  });
}

export interface StartBrowseJobResult {
  job: BrowseJob;
  busy: boolean;
}

/**
 * Start a copy/move operation for the given entries. Returns busy=true when
 * another job is already writing to the same destination (or reading from
 * the same source).
 */
export async function startBrowseCopyMove(
  db: Database,
  operation: "copy" | "move",
  src: BrowseRef,
  dst: BrowseRef,
  names: string[],
  hostId: string,
): Promise<StartBrowseJobResult> {
  if (names.length === 0) throw new Error("no entries selected");

  // LAMA-226 P1-2: self-move deletes data. Two cases that need different
  // handling — same-kind local moves must reject when dst equals or nests
  // under any of the source names (rmSync of the same path); same-folder
  // S3 moves are allowed when the prefix changes.
  if (src.kind === "local" && dst.kind === "local") {
    for (const name of names) {
      if (isContainedLocalMove(src.path, name, dst.path)) {
        throw new Error("source and destination are the same path");
      }
    }
  } else if (
    src.kind === "s3" &&
    dst.kind === "s3" &&
    src.folderId === dst.folderId
  ) {
    if (!isSafeS3IntraFolderMove(src.path, dst.path, names)) {
      throw new Error("source and destination are the same prefix");
    }
  }

  // Concurrency guard: same destination (ref + path) must not see two jobs.
  const dKey = destKey(dst);
  const sKey = `${destKey(src)}|${names.join(",")}`;
  if (activeDestinations.has(dKey) || activeSources.has(sKey)) {
    const job = insertFailedJob(db, operation, sKey, dKey, "destination busy — another operation is writing there");
    return { job, busy: true };
  }
  const pendingDest = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM browse_jobs WHERE destination = ? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(dKey);
  if (pendingDest) {
    const job = insertFailedJob(db, operation, sKey, dKey, "destination busy — another operation is writing there");
    return { job, busy: true };
  }
  const pendingSrc = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM browse_jobs WHERE source = ? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(sKey);
  if (pendingSrc) {
    const job = insertFailedJob(db, operation, sKey, dKey, "destination busy — another operation is writing there");
    return { job, busy: true };
  }

  activeDestinations.add(dKey);
  activeSources.add(sKey);
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation,
    source: sKey,
    destination: dKey,
    status: "running",
    error: null,
    progressBytes: 0,
    totalBytes: names.length,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', NULL, 0, ?, ?, ?)`,
    [job.id, operation, job.source, job.destination, names.length, now, now],
  );
  emit(db, job);

  // Pre-resolve the buckets so the job rows match the rclone argv even when
  // the source folder is deleted mid-flight (the spawned process still has
  // its config file). For local refs the bucket is null.
  let srcBucket: string | null = null;
  let dstBucket: string | null = null;
  try {
    if (src.kind === "s3") srcBucket = resolveS3(db, src).bucket;
    if (dst.kind === "s3") dstBucket = resolveS3(db, dst).bucket;
  } catch (error) {
    activeDestinations.delete(dKey);
    activeSources.delete(sKey);
    const msg = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.error = msg;
    job.updatedAt = Date.now();
    writeJob(db, job);
    emit(db, job);
    return { job, busy: false };
  }

  void (async () => {
    try {
      await runCopy(db, job, src, dst, names, { srcBucket, dstBucket });
      if (operation === "move") {
        // Move = copy then delete the source; both report into the same job.
        await deleteSource(db, src, names, srcBucket);
      }
      job.status = "done";
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
      // A browse op changes what's on disk/S3 — drop cached sizes.
      invalidateStorageReport();
      if (src.kind === "s3" && src.folderId) invalidateFolderSize(src.folderId);
      if (dst.kind === "s3" && dst.folderId) invalidateFolderSize(dst.folderId);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
    } finally {
      activeDestinations.delete(dKey);
      activeSources.delete(sKey);
    }
  })();

  return { job, busy: false };
}

/** Rename an entry in place (rclone moveto works for files and dirs). */
export async function startBrowseRename(
  db: Database,
  ref: BrowseRef,
  from: string,
  to: string,
  hostId: string,
): Promise<BrowseJob> {
  assertSafePath(ref.path, from);
  assertSafePath(ref.path, to);
  const dKey = destKey(ref);
  const sKey = `${destKey(ref)}|${from}`;
  if (activeDestinations.has(dKey) || activeSources.has(sKey)) {
    return insertFailedJob(db, "rename", sKey, dKey, "destination busy — another operation is writing there");
  }
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: "rename",
    source: sKey,
    destination: dKey,
    status: "running",
    error: null,
    progressBytes: null,
    totalBytes: null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
     VALUES (?, 'rename', ?, ?, 'running', NULL, NULL, NULL, ?, ?)`,
    [job.id, job.source, job.destination, now, now],
  );
  emit(db, job);

  let bucket: string | null = null;
  try {
    if (ref.kind === "s3") bucket = resolveS3(db, ref).bucket;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.error = msg;
    job.updatedAt = Date.now();
    writeJob(db, job);
    emit(db, job);
    return job;
  }

  activeDestinations.add(dKey);
  activeSources.add(sKey);
  void (async () => {
    try {
      const config = buildJobConfig(db, ref, ref);
      await withTempRcloneConfig(config, async (configPath) => {
        const argvInput: BuildArgvInput = {
          operation: "moveto",
          configPath,
          srcRemote: "src",
          srcPath: remotePath(ref, from, bucket ?? undefined),
          dstRemote: "src",
          dstPath: remotePath(ref, to, bucket ?? undefined),
          timeout: "30s",
        };
        const result = await runRclone(buildRcloneArgv(argvInput));
        if (result.code !== 0) {
          throw rcloneFailure("moveto", result);
        }
      });
      job.status = "done";
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
      if (ref.kind === "s3" && ref.folderId) invalidateFolderSize(ref.folderId);
      invalidateStorageReport();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
    } finally {
      activeDestinations.delete(dKey);
      activeSources.delete(sKey);
    }
  })();
  return job;
}

/**
 * Delete entries (files + directories, recursive) from a browse ref. Mirrors
 * copy/move: one rclone step per entry — `deletefile` for files, `purge` for
 * directories (the two rclone ops that match the browser's file/dir split;
 * `delete --rmdirs` would silently skip non-empty directories). The entry
 * type is resolved server-side: local via a stat, s3 via a prefix listing.
 */
export async function startBrowseDelete(
  db: Database,
  ref: BrowseRef,
  names: string[],
  hostId: string,
): Promise<StartBrowseJobResult> {
  if (names.length === 0) throw new Error("no entries selected");
  for (const name of names) assertSafePath(ref.path, name);

  const dKey = destKey(ref);
  const sKey = `${dKey}|${names.join(",")}`;
  if (activeDestinations.has(dKey) || activeSources.has(sKey)) {
    const job = insertFailedJob(db, "delete", sKey, dKey, "destination busy — another operation is writing there");
    return { job, busy: true };
  }
  const pendingDest = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM browse_jobs WHERE destination = ? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(dKey);
  if (pendingDest) {
    const job = insertFailedJob(db, "delete", sKey, dKey, "destination busy — another operation is writing there");
    return { job, busy: true };
  }
  const pendingSrc = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM browse_jobs WHERE source = ? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(sKey);
  if (pendingSrc) {
    const job = insertFailedJob(db, "delete", sKey, dKey, "destination busy — another operation is writing there");
    return { job, busy: true };
  }

  activeDestinations.add(dKey);
  activeSources.add(sKey);
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: "delete",
    source: sKey,
    destination: dKey,
    status: "running",
    error: null,
    progressBytes: 0,
    totalBytes: names.length,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
     VALUES (?, 'delete', ?, ?, 'running', NULL, 0, ?, ?, ?)`,
    [job.id, job.source, job.destination, names.length, now, now],
  );
  emit(db, job);

  let bucket: string | null = null;
  try {
    if (ref.kind === "s3") bucket = resolveS3(db, ref).bucket;
  } catch (error) {
    activeDestinations.delete(dKey);
    activeSources.delete(sKey);
    const msg = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.error = msg;
    job.updatedAt = Date.now();
    writeJob(db, job);
    emit(db, job);
    return { job, busy: false };
  }

  void (async () => {
    try {
      const config = buildJobConfig(db, ref, ref);
      await withTempRcloneConfig(config, async (configPath) => {
        let completed = 0;
        for (const name of names) {
          const type = await resolveEntryType(db, ref, name);
          const op = type === "dir" ? "purge" : "deletefile";
          const argvInput: BuildArgvInput = {
            operation: op,
            configPath,
            srcRemote: "src",
            srcPath: remotePath(ref, name, bucket ?? undefined),
            timeout: "30s",
          };
          const result = await runRclone(buildRcloneArgv(argvInput));
          if (result.code !== 0) {
            throw rcloneFailure(op, result);
          }
          completed += 1;
          job.progressBytes = completed;
          job.updatedAt = Date.now();
          writeJob(db, job);
          emit(db, job);
        }
      });
      job.status = "done";
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
      invalidateStorageReport();
      if (ref.kind === "s3" && ref.folderId) invalidateFolderSize(ref.folderId);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
    } finally {
      activeDestinations.delete(dKey);
      activeSources.delete(sKey);
    }
  })();

  return { job, busy: false };
}

/** Resolve whether a named entry is a file or directory on its backend. */
async function resolveEntryType(
  db: Database,
  ref: BrowseRef,
  name: string,
): Promise<"dir" | "file"> {
  if (ref.kind === "local") {
    const cwd = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
    const stat = statEntry(join(cwd, ref.path, name));
    if (!stat) throw new Error(`entry not found: ${name}`);
    return stat.type;
  }
  const s3 = resolveS3(db, ref);
  const config: S3FolderConfig = {
    folderId: s3.folder.id,
    backendId: s3.folder.backendId ?? "",
    provider: s3.provider,
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    region: s3.region,
  };
  const listing = await listS3Objects(config, ref.path, 1000);
  const entry = listing.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`entry not found: ${name}`);
  return entry.type;
}

/** Create a directory at the ref's current path. */
export async function startBrowseMkdir(
  db: Database,
  ref: BrowseRef,
  name: string,
  hostId: string,
): Promise<BrowseJob> {
  assertSafePath(ref.path, name);
  const dKey = destKey(ref);
  if (activeDestinations.has(dKey)) {
    return insertFailedJob(
      db,
      "mkdir",
      dKey,
      `${dKey}/${name}`,
      "destination busy — another operation is writing there",
    );
  }
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: "mkdir",
    source: dKey,
    destination: `${dKey}/${name}`,
    status: "running",
    error: null,
    progressBytes: null,
    totalBytes: null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
     VALUES (?, 'mkdir', ?, ?, 'running', NULL, NULL, NULL, ?, ?)`,
    [job.id, job.source, job.destination, now, now],
  );
  emit(db, job);

  let bucket: string | null = null;
  try {
    if (ref.kind === "s3") bucket = resolveS3(db, ref).bucket;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.error = msg;
    job.updatedAt = Date.now();
    writeJob(db, job);
    emit(db, job);
    return job;
  }

  activeDestinations.add(dKey);
  void (async () => {
    try {
      const config = buildJobConfig(db, ref, ref);
      await withTempRcloneConfig(config, async (configPath) => {
        const argvInput: BuildArgvInput = {
          operation: "mkdir",
          configPath,
          srcRemote: "src",
          srcPath: remotePath(ref, name, bucket ?? undefined),
          timeout: "30s",
        };
        const result = await runRclone(buildRcloneArgv(argvInput));
        if (result.code !== 0) {
          throw rcloneFailure("mkdir", result);
        }
      });
      job.status = "done";
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
      if (ref.kind === "s3" && ref.folderId) invalidateFolderSize(ref.folderId);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
    } finally {
      activeDestinations.delete(dKey);
    }
  })();
  return job;
}

/**
 * Upload a single file to the destination directory. The payload arrives as
 * base64 (bounded) in the request body; it is staged to a temp file and
 * pushed with `rclone copyto`.
 */
export async function startBrowseUpload(
  db: Database,
  dst: BrowseRef,
  fileName: string,
  base64Content: string,
  hostId: string,
): Promise<BrowseJob> {
  assertSafePath(dst.path, fileName);
  const bytes = Buffer.from(base64Content, "base64");
  if (bytes.length > 64 * 1024 * 1024) {
    throw new Error("upload exceeds the 64 MiB base64 limit; use an S3 folder sync instead");
  }
  const tmp = `/tmp/lamasync-upload-${crypto.randomUUID()}`;
  await Bun.write(tmp, bytes);
  const dKey = destKey(dst);
  if (activeDestinations.has(dKey)) {
    try {
      await Bun.spawn(["rm", "-f", tmp]).exited;
    } catch {
      // best-effort
    }
    return insertFailedJob(
      db,
      "upload",
      `upload:${fileName} (${bytes.length} bytes)`,
      `${dKey}/${fileName}`,
      "destination busy — another operation is writing there",
    );
  }
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: "upload",
    source: `upload:${fileName} (${bytes.length} bytes)`,
    destination: `${dKey}/${fileName}`,
    status: "running",
    error: null,
    progressBytes: 0,
    totalBytes: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
     VALUES (?, 'upload', ?, ?, 'running', NULL, 0, 1, ?, ?)`,
    [job.id, job.source, job.destination, now, now],
  );
  emit(db, job);

  let bucket: string | null = null;
  try {
    if (dst.kind === "s3") bucket = resolveS3(db, dst).bucket;
  } catch (error) {
    try {
      await Bun.spawn(["rm", "-f", tmp]).exited;
    } catch {
      // best-effort
    }
    const msg = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.error = msg;
    job.updatedAt = Date.now();
    writeJob(db, job);
    emit(db, job);
    return job;
  }

  activeDestinations.add(dKey);
  void (async () => {
    try {
      const config = buildJobConfig(db, dst, dst);
      await withTempRcloneConfig(config, async (configPath) => {
        // The source is a plain local temp file: pass it BARE (no colon).
        // `buildRcloneArgv` would join `srcRemote:srcPath` as `<tmp>:` —
        // rclone then parses the temp path (which contains `/`) including
        // the colon as a local path and fails with ENOENT.
        // Remote naming: for an s3 dst, buildJobConfig(dst, dst) takes the
        // same-folder branch and names the single s3 section `[src]`; for a
        // local dst the generic branch names the local section `[dst]`.
        const dstRemote = bucket === null ? "dst" : "src";
        const argv = [
          "rclone",
          "copyto",
          tmp,
          `${dstRemote}:${remotePath(dst, fileName, bucket ?? undefined)}`,
          "--config",
          configPath,
          "--timeout",
          "30s",
        ];
        const result = await runRclone(argv);
        if (result.code !== 0) {
          throw rcloneFailure("copyto", result);
        }
      });
      job.status = "done";
      job.progressBytes = 1;
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
      if (dst.kind === "s3" && dst.folderId) invalidateFolderSize(dst.folderId);
      invalidateStorageReport();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
      appendOperationLog(db, job, hostId);
    } finally {
      activeDestinations.delete(dKey);
      try {
        await Bun.spawn(["rm", "-f", tmp]).exited;
      } catch {
        // best-effort
      }
    }
  })();
  return job;
}

export interface DownloadResult {
  name: string;
  content: string; // base64
}

export type DownloadOutcome =
  | { ok: true; data: DownloadResult }
  | { ok: false; status: number; error: string };

const MAX_BROWSE_BYTES = 64 * 1024 * 1024;

/**
 * Read a single file from a browse ref and return it base64-encoded.
 * Mirrors the upload cap: files at or under 64 MiB decode/return whole;
 * larger files fail with the limit named in the error. Local refs are read
 * straight off disk; s3 refs stream through `rclone cat`.
 */
export async function downloadBrowseFile(
  db: Database,
  ref: BrowseRef,
  name: string,
): Promise<DownloadOutcome> {
  assertSafePath(ref.path, name);

  if (ref.kind === "local") {
    const cwd = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
    const rel = ref.path ? `${ref.path}/${name}` : name;
    // realpath containment: a symlink inside the backup root that points
    // outside it must not be followed (same guard as the listing route).
    let target: string;
    try {
      const resolved = resolveBrowsePath(cwd, rel);
      if (resolved === null) {
        return { ok: false, status: 404, error: "entry not found" };
      }
      target = resolved;
    } catch {
      return { ok: false, status: 500, error: "failed to read entry" };
    }
    const stat = statEntry(target);
    if (stat === null) {
      // Vanished between resolve and stat (TOCTOU race).
      return { ok: false, status: 404, error: "entry not found" };
    }
    if (stat.type === "dir") {
      return { ok: false, status: 400, error: "cannot download a directory" };
    }
    if (stat.size > MAX_BROWSE_BYTES) {
      return {
        ok: false,
        status: 400,
        error: `file is ${stat.size} bytes; download limit is 64 MiB`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(target);
    } catch {
      return { ok: false, status: 500, error: "failed to read entry" };
    }
    return { ok: true, data: { name, content: bytes.toString("base64") } };
  }

  // s3: `rclone cat` the object; the buffer is bounded by the same cap.
  let bucket: string;
  try {
    bucket = resolveS3(db, ref).bucket;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 400, error: msg };
  }
  const config = buildJobConfig(db, ref, ref);
  try {
    return await withTempRcloneConfig(config, async (configPath) => {
      const argvInput: BuildArgvInput = {
        operation: "cat",
        configPath,
        srcRemote: "src",
        srcPath: remotePath(ref, name, bucket),
        timeout: "60s",
      };
      const result = await runRcloneBinary(buildRcloneArgv(argvInput));
      if (result.code !== 0) {
        throw rcloneFailure("cat", result);
      }
      if (result.stdout.length > MAX_BROWSE_BYTES) {
        return {
          ok: false,
          status: 400,
          error: `file is ${result.stdout.length} bytes; download limit is 64 MiB`,
        } as const;
      }
      return {
        ok: true,
        data: { name, content: result.stdout.toString("base64") },
      } as const;
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 400, error: msg };
  }
}

export function listBrowseJobs(db: Database, limit = 50): BrowseJob[] {
  const rows = db
    .query<BrowseJobRow, [number]>(
      `${JOB_SELECT} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 200)));
  const jobs: BrowseJob[] = [];
  for (const row of rows) {
    try {
      jobs.push(rowToJob(row));
    } catch (err) {
      // An unknown operation slipped in (e.g. a legacy row). Skip rather
      // than fail the whole list — the detail endpoint surfaces the raw
      // row, the list view should still render the rest.
      console.warn(`[browse-jobs] dropping unparseable row: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return jobs;
}

/**
 * Build the rclone config text for one browse operation. Resolves the S3
 * sections for both sides (or local placeholders) and emits a complete
 * config body. Pure apart from the DB read of the folder rows + secrets.
 *
 * Exported for tests via the wrapped pure helpers in `browse-rclone.ts`
 * (this function is the seam that joins those with `db`).
 */
function buildJobConfig(db: Database, src: BrowseRef, dst: BrowseRef): string {
  if (src.kind === "s3" && dst.kind === "s3" && src.folderId === dst.folderId) {
    // Both sides resolve to the same bucket — emit a single `[src]` section
    // (dst: null). Callers must use the `src` remote for BOTH argv sides;
    // there is no `[dst]` section in this config.
    const r = resolveS3(db, src);
    return buildRcloneConfig({
      src: {
        name: "src",
        folder: r.folder,
        provider: r.provider,
        endpoint: r.endpoint,
        accessKeyId: r.accessKeyId,
        secretAccessKey: r.secretAccessKey,
        region: r.region,
        bucket: r.bucket,
      },
      dst: null,
    });
  }
  const srcSection =
    src.kind === "s3"
      ? (() => {
          const r = resolveS3(db, src);
          return {
            name: "src",
            folder: r.folder,
            provider: r.provider,
            endpoint: r.endpoint,
            accessKeyId: r.accessKeyId,
            secretAccessKey: r.secretAccessKey,
            region: r.region,
            bucket: r.bucket,
          };
        })()
      : { name: "src" };
  const dstSection =
    dst.kind === "s3"
      ? (() => {
          const r = resolveS3(db, dst);
          return {
            name: "dst",
            folder: r.folder,
            provider: r.provider,
            endpoint: r.endpoint,
            accessKeyId: r.accessKeyId,
            secretAccessKey: r.secretAccessKey,
            region: r.region,
            bucket: r.bucket,
          };
        })()
      : { name: "dst" };
  return buildRcloneConfig({ src: srcSection, dst: dstSection });
}

// Exported for tests.
export function __jobExists(db: Database, id: string): boolean {
  return db
    .query<{ id: string }, [string]>("SELECT id FROM browse_jobs WHERE id = ?")
    .get(id) !== undefined;
}

/**
 * LAMA-226 P1-3: jobs left `running` after a server crash would otherwise
 * block destinations forever once the key matches. Walk the rows at boot
 * and mark them `failed` with an explanatory note. Idempotent.
 */
export function reconcileStuckBrowseJobs(db: Database): number {
  const rows = db
    .query<
      {
        id: string;
        operation: string;
        source: string;
        destination: string;
      },
      []
    >(
      `SELECT id, operation, source, destination FROM browse_jobs WHERE status = 'running'`,
    )
    .all();
  const now = Date.now();
  let reconciled = 0;
  for (const row of rows) {
    db.run(
      `UPDATE browse_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      ["server restarted while job was in flight", now, row.id],
    );
    reconciled += 1;
  }
  return reconciled;
}