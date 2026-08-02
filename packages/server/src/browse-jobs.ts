// LAMA-226: Data Browser write-operation engine. Each operation runs as a
// `browse_job` row: created pending, marked running while rclone executes,
// and updated on every completed entry (progress_bytes/total_bytes count
// entries). Terminal jobs write an operation_log row for the audit trail.
//
// Concurrency guard: one in-memory + DB-backed "destination busy" check so
// two operators can't write to the same target simultaneously.

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type {
  BrowseJob,
  BrowseJobOperation,
  BrowseRef,
  Folder,
} from "@lamasync/core";
import { broadcast } from "./ws.ts";
import { resolveFolderS3Config, getBackend } from "./backends.ts";
import { decryptSecret } from "./crypto.ts";
import { invalidateFolderSize, invalidateStorageReport } from "./stats.ts";
import { validateBrowseInput } from "./browse-paths.ts";

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

const activeDestinations = new Set<string>();

export function __resetBrowseJobsForTests(): void {
  activeDestinations.clear();
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

function rowToJob(row: BrowseJobRow): BrowseJob {
  return {
    id: row.id,
    operation: row.operation as BrowseJobOperation,
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

/** Human-readable label for a ref, used in the job + operation log. */
export function refLabel(ref: BrowseRef): string {
  const p = ref.path.replace(/\/+$/, "") || ".";
  return ref.kind === "s3" ? `s3:${ref.folderId ?? "?"}:${p}` : `local:${p}`;
}

/** Canonical destination key for the concurrency guard. */
function destKey(ref: BrowseRef, path: string): string {
  const joined = `${ref.path}/${path}`.replace(/\/+/g, "/");
  return `${ref.kind}:${ref.folderId ?? ""}:${joined}`;
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
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", ...opts });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** Build a temp rclone config with the remotes needed for one operation. */
async function buildConfig(
  db: Database,
  src: BrowseRef,
  dst: BrowseRef,
): Promise<{ config: string; configPath: string }> {
  const lines: string[] = [];
  const addS3 = (name: string, folder: Folder): void => {
    const s3 = resolveFolderS3Config(db, folder);
    if (!s3) throw new Error(`folder ${folder.id} has no resolvable S3 backend`);
    const backend = getBackend(db, s3.backendId);
    const secret = decryptSecret(backend?.s3_secret_key_enc) ?? "";
    lines.push(`[${name}]`);
    lines.push("type = s3");
    lines.push(`provider = ${s3.provider === "aws" ? "AWS" : "Other"}`);
    lines.push("env_auth = false");
    lines.push(`access_key_id = ${s3.accessKeyId}`);
    lines.push(`secret_access_key = ${secret}`);
    lines.push(`endpoint = ${s3.endpoint}`);
    if (s3.region) lines.push(`region = ${s3.region}`);
    lines.push("");
  };
  const addLocal = (name: string): void => {
    lines.push(`[${name}]`);
    lines.push("type = local");
    lines.push("");
  };

  if (src.kind === "s3") {
    const folder = loadFolder(db, src.folderId);
    addS3("src", folder);
  } else {
    addLocal("src");
  }
  if (dst.kind === "s3") {
    const folder = loadFolder(db, dst.folderId);
    addS3("dst", folder);
  } else {
    addLocal("dst");
  }

  const configPath = `/tmp/lamasync-browse-${crypto.randomUUID()}.conf`;
  await Bun.write(configPath, lines.join("\n"));
  return { config: lines.join("\n"), configPath };
}

function loadFolder(db: Database, folderId: string | null | undefined): Folder {
  if (!folderId) throw new Error("s3 ref requires folderId");
  const row = db
    .query<{ id: string; name: string; backend: string | null; backend_id: string | null; s3_bucket: string | null }, [string]>(
      "SELECT id, name, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
    )
    .get(folderId);
  if (!row) throw new Error(`folder ${folderId} not found`);
  if (row.backend !== "s3" || !row.backend_id) {
    throw new Error(`folder ${folderId} is not an S3 folder`);
  }
  return {
    id: row.id,
    name: row.name,
    type: "backup",
    backend: "s3",
    backendId: row.backend_id,
    s3Bucket: row.s3_bucket,
  };
}

/** Resolve a ref's relative path into an rclone remote path string. */
function remotePath(ref: BrowseRef, name?: string): string {
  const base = ref.path.replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = [base, name].filter((p): p is string => p !== undefined && p !== "");
  return parts.join("/");
}

function assertSafePath(path: string, name: string): void {
  if (!validateBrowseInput(`${path}/${name}`)) {
    throw new Error(`unsafe path for ${name}`);
  }
}

/** Local backup root — same root the read-only browser uses. */
function backupRoot(): string {
  return process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
}

async function runCopy(
  db: Database,
  job: BrowseJob,
  src: BrowseRef,
  dst: BrowseRef,
  names: string[],
): Promise<void> {
  const { configPath } = await buildConfig(db, src, dst);
  const cwd = backupRoot();
  let completed = 0;
  try {
    for (const name of names) {
      assertSafePath(src.path, name);
      assertSafePath(dst.path, name);
      // `copyto` handles both files and directories (recursive for dirs) and
      // creates the destination path — uniform per-entry copy.
      const result = await runRclone(
        [
          "rclone",
          "copyto",
          `src:${remotePath(src, name)}`,
          `dst:${remotePath(dst, name)}`,
          "--config",
          configPath,
          "--timeout",
          "30s",
        ],
        { cwd },
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim().split("\n").pop() ?? `rclone copy failed (${result.code})`);
      }
      completed += 1;
      job.progressBytes = completed;
      job.totalBytes = names.length;
      job.updatedAt = Date.now();
      writeJob(db, job);
      emit(db, job);
    }
  } finally {
    try {
      await Bun.spawn(["rm", "-f", configPath]).exited;
    } catch {
      // best-effort cleanup
    }
  }
}

async function deleteSource(
  db: Database,
  src: BrowseRef,
  names: string[],
  configPath: string,
): Promise<void> {
  const cwd = backupRoot();
  for (const name of names) {
    if (src.kind === "local") {
      // Server-side rm -rf of the copied source (the issue's contract:
      // "server-side rm -rf of source after success").
      const target = join(cwd, src.path, name);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    } else {
      // S3 source: `rclone delete <path> --rmdirs` removes files under the
      // path and prunes the emptied directories (the rm -rf equivalent).
      const result = await runRclone(
        [
          "rclone",
          "delete",
          `src:${remotePath(src, name)}`,
          "--rmdirs",
          "--config",
          configPath,
          "--timeout",
          "30s",
        ],
        { cwd },
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim().split("\n").pop() ?? `rclone delete failed (${result.code})`);
      }
    }
  }
}

export interface StartBrowseJobResult {
  job: BrowseJob;
  busy: boolean;
}

/**
 * Start a copy/move operation for the given entries. Returns busy=true when
 * another job is already writing to the same destination.
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
  if (src.kind === "s3" && dst.kind === "s3" && src.folderId === dst.folderId) {
    throw new Error("source and destination are the same folder");
  }
  // Concurrency guard: same destination (ref + path) must not see two jobs.
  const key = destKey(dst, "");
  if (activeDestinations.has(key)) return { job: null as never, busy: true };
  const pending = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM browse_jobs WHERE destination = ? AND status IN ('pending','running') LIMIT 1`,
    )
    .get(`${dst.kind}:${dst.folderId ?? ""}:${dst.path}`);
  if (pending) return { job: null as never, busy: true };

  activeDestinations.add(key);
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation,
    source: refLabel(src),
    destination: `${refLabel(dst)}${names.length === 1 ? `/${names[0]}` : ""}`,
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

  void (async () => {
    try {
      await runCopy(db, job, src, dst, names);
      if (operation === "move") {
        // Move = copy then delete the source; both report into the same job.
        const { configPath } = await buildConfig(db, src, dst);
        try {
          await deleteSource(db, src, names, configPath);
        } finally {
          try {
            await Bun.spawn(["rm", "-f", configPath]).exited;
          } catch {
            // best-effort
          }
        }
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
      activeDestinations.delete(key);
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
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: "rename",
    source: refLabel(ref),
    destination: `${refLabel(ref)}/${to}`,
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
  void (async () => {
    try {
      const { configPath } = await buildConfig(db, ref, ref);
      try {
        const result = await runRclone(
          [
            "rclone",
            "moveto",
            `src:${remotePath(ref, from)}`,
            `src:${remotePath(ref, to)}`,
            "--config",
            configPath,
            "--timeout",
            "30s",
          ],
          { cwd: backupRoot() },
        );
        if (result.code !== 0) {
          throw new Error(result.stderr.trim().split("\n").pop() ?? `rclone moveto failed (${result.code})`);
        }
      } finally {
        try {
          await Bun.spawn(["rm", "-f", configPath]).exited;
        } catch {
          // best-effort
        }
      }
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
    }
  })();
  return job;
}

/** Create a directory at the ref's current path. */
export async function startBrowseMkdir(
  db: Database,
  ref: BrowseRef,
  name: string,
  hostId: string,
): Promise<BrowseJob> {
  assertSafePath(ref.path, name);
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: "mkdir",
    source: refLabel(ref),
    destination: `${refLabel(ref)}/${name}`,
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
  void (async () => {
    try {
      const { configPath } = await buildConfig(db, ref, ref);
      try {
        const result = await runRclone(
          ["rclone", "mkdir", `src:${remotePath(ref, name)}`, "--config", configPath, "--timeout", "30s"],
          { cwd: backupRoot() },
        );
        if (result.code !== 0) {
          throw new Error(result.stderr.trim().split("\n").pop() ?? `rclone mkdir failed (${result.code})`);
        }
      } finally {
        try {
          await Bun.spawn(["rm", "-f", configPath]).exited;
        } catch {
          // best-effort
        }
      }
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
  const now = Date.now();
  const job: BrowseJob = {
    id: crypto.randomUUID(),
    operation: "upload",
    source: `upload:${fileName} (${bytes.length} bytes)`,
    destination: `${refLabel(dst)}/${fileName}`,
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
  void (async () => {
    try {
      const { configPath } = await buildConfig(db, dst, dst);
      try {
        const result = await runRclone(
          ["rclone", "copyto", tmp, `dst:${remotePath(dst, fileName)}`, "--config", configPath, "--timeout", "30s"],
          { cwd: backupRoot() },
        );
        if (result.code !== 0) {
          throw new Error(result.stderr.trim().split("\n").pop() ?? `rclone copyto failed (${result.code})`);
        }
      } finally {
        try {
          await Bun.spawn(["rm", "-f", configPath, tmp]).exited;
        } catch {
          // best-effort
        }
      }
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
    }
  })();
  return job;
}

export function listBrowseJobs(db: Database, limit = 50): BrowseJob[] {
  const rows = db
    .query<BrowseJobRow, [number]>(
      `${JOB_SELECT} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 200)));
  return rows.map(rowToJob);
}

// Re-exported for tests (statSync unused in prod path but handy for the
// move-source existence check).
export function __jobExists(db: Database, id: string): boolean {
  return db
    .query<{ id: string }, [string]>("SELECT id FROM browse_jobs WHERE id = ?")
    .get(id) !== undefined;
}
