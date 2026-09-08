// LAMA-324: app-backup archive storage adapter (server-relay).
//
// The daemon uploads a tarball to the server; the server then publishes it
// either to the server-local archive (the historical default) or relays it
// to a selected backend under a FIXED object key. Every snapshot row
// persists its immutable physical location (`backend_id` + `object_key` +
// `s3_bucket`, or the BACKUP_DIR-relative `archive_path` for server-local),
// so download/delete dispatch from the stored values — never from the
// protection's current destination (destinations may change after capture).
//
// Kinds:
//   - s3    → rclone copyto/cat/deletefile against a generated 0600 temp
//             config (credentials never cross the process boundary).
//   - local/nfs → these are server-visible directories (rclone type =
//             local by definition); the server uses direct filesystem
//             operations with strict containment validation instead of
//             spawning rclone. Same fixed object key under the backend's
//             absolute localPath.
//
// LAMA-325 retention reuses `deleteSnapshotArchiveForRow` — the reusable
// delete primitive — and `locationForSnapshot` to build decision inputs.

import { decryptSecret } from "./crypto.ts";
import { getBackend, type BackendRow } from "./backends.ts";
import { withTempRcloneConfig, writeTempRcloneConfig } from "./temp-rclone-config.ts";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, renameSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Database } from "bun:sqlite";

/** Fixed remote layout prefix under any backend's root/bucket. */
export const APP_ARCHIVE_PREFIX = "lamasync/apps";

/** Backend kinds an app backup destination may select (restic excluded —
 *  restic repos store snapshots differently and are out of scope here). */
export const ALLOWED_APP_BACKEND_KINDS = ["s3", "local", "nfs"] as const;

export function isAllowedAppBackendKind(kind: string): boolean {
  return (ALLOWED_APP_BACKEND_KINDS as readonly string[]).includes(kind);
}

/** Fixed key: lamasync/apps/<protectionId>/<snapshotId>.tar.gz. */
export function appObjectKey(protectionId: string, snapshotId: string): string {
  return `${APP_ARCHIVE_PREFIX}/${protectionId}/${snapshotId}.tar.gz`;
}

/** Server-local staging dir OUTSIDE browse roots (uploads land here first,
 *  are verified, then published). */
export function appStagingRoot(): string {
  return process.env.LAMASYNC_APPS_STAGING_DIR ?? join(tmpdir(), "lamasync-app-staging");
}

// ---------------------------------------------------------------------------
// rclone exec seam (tests inject a fake rclone; production spawns the real
// binary). Mirrors the __setDb pattern used across the server package.
// ---------------------------------------------------------------------------

export interface RcloneRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RcloneExec {
  (argv: string[]): Promise<RcloneRun>;
}

let rcloneExecForTests: RcloneExec | null = null;

/** Test seam: replace the rclone spawner. Pass null to restore. */
export function __setRcloneExecForTest(fn: RcloneExec | null): void {
  rcloneExecForTests = fn;
}

async function runRclone(argv: string[]): Promise<RcloneRun> {
  if (rcloneExecForTests !== null) return rcloneExecForTests(argv);
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * `rclone cat` variant that streams stdout to the caller while still being
 * seam-testable. Owns the temp config dir lifecycle: the config file must
 * outlive the rclone process, so cleanup runs when the process exits, not
 * when this function returns.
 */
async function catRemoteS3(
  configBody: string,
  remotePath: string,
): Promise<{ stream: ReadableStream<Uint8Array>; run: Promise<RcloneRun> }> {
  if (rcloneExecForTests !== null) {
    const run = await rcloneExecForTests([
      "rclone",
      "cat",
      `relay:${remotePath}`,
      "--config",
      "<test-config>",
    ]);
    const stream = new Blob([run.stdout]).stream() as ReadableStream<Uint8Array>;
    return { stream, run: Promise.resolve(run) };
  }
  const { configPath, dir } = writeTempRcloneConfig(configBody);
  try {
    const proc = Bun.spawn(
      ["rclone", "cat", `relay:${remotePath}`, "--config", configPath, "--timeout", "120s"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const run: Promise<RcloneRun> = Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stderr, code]) => {
      rmSync(dir, { recursive: true, force: true });
      return { code, stdout: "", stderr };
    });
    return { stream: proc.stdout as ReadableStream<Uint8Array>, run };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Does rclone's stderr indicate the object was already absent? deletefile
 *  (and cat) report "object not found" style errors for missing keys; those
 *  must NOT surface as a failed prune in retention accounting. */
function looksLikeNotFound(stderr: string): boolean {
  return /not found|no such file|object does not exist|key does not exist|404|NoSuchKey/i.test(
    stderr,
  );
}

// ---------------------------------------------------------------------------
// Location contract: every snapshot is identified by its stored physical
// location, never by the protection's current destination.
// ---------------------------------------------------------------------------

export interface SnapshotLocationRow {
  backend_id: string | null;
  object_key: string | null;
  s3_bucket: string | null;
  archive_path: string;
}

export interface SnapshotLocation {
  /** Backend the object lives on; null = server-local archive. */
  backendId: string | null;
  /** Backend-relative object key (backend snapshots). */
  objectKey: string | null;
  /** Bucket for s3-kind backend snapshots. */
  s3Bucket: string | null;
  /** BACKUP_DIR-relative path for server-local snapshots. */
  localRelPath: string;
}

export function locationForSnapshot(row: SnapshotLocationRow): SnapshotLocation {
  if (row.backend_id !== null) {
    return {
      backendId: row.backend_id,
      objectKey: row.object_key ?? null,
      s3Bucket: row.s3_bucket ?? null,
      localRelPath: "",
    };
  }
  return {
    backendId: null,
    objectKey: null,
    s3Bucket: null,
    localRelPath: row.archive_path,
  };
}

// ---------------------------------------------------------------------------
// Backend resolution + config generation.
// ---------------------------------------------------------------------------

export interface ResolvedAppBackend {
  row: BackendRow;
  /** Absolute server-side directory for local/nfs kinds (validated). */
  localPath: string | null;
  /** rclone config body for s3 kinds (null when incomplete). */
  s3Config: string | null;
}

/** Resolve a backend row for app-archive use. Fails closed: the backend
 *  must exist and be an allowed kind; s3 configs must carry full
 *  credentials; local/nfs must carry an absolute server-side path. */
export function resolveAppBackend(db: Database, backendId: string): ResolvedAppBackend | null {
  const backend = getBackend(db, backendId);
  if (!backend) return null;
  if (!isAllowedAppBackendKind(backend.kind)) return null;
  if (backend.kind === "s3") {
    const config = buildS3RelayConfig(backend);
    if (config === null) return null;
    return { row: backend, localPath: null, s3Config: config };
  }
  const localPath = (backend.local_path ?? "").trim();
  if (localPath === "" || !localPath.startsWith("/")) return null;
  return { row: backend, localPath, s3Config: null };
}

function buildS3RelayConfig(backend: BackendRow): string | null {
  const endpoint = (backend.s3_endpoint ?? "").trim();
  const accessKeyId = (backend.s3_access_key_id ?? "").trim();
  const secretKey = decryptSecret(backend.s3_secret_key_enc) ?? "";
  if (endpoint === "" || accessKeyId === "" || secretKey === "") return null;
  const region = (backend.s3_region ?? "").trim();
  return [
    "[relay]",
    "type = s3",
    `provider = ${backend.s3_provider === "aws" ? "AWS" : "Other"}`,
    "env_auth = false",
    `access_key_id = ${accessKeyId}`,
    `secret_access_key = ${secretKey}`,
    `endpoint = ${endpoint}`,
    ...(region !== "" ? [`region = ${region}`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Publish (stage → verify → revalidate → publish → cleanup staging).
// ---------------------------------------------------------------------------

export interface PublishInput {
  /** Absolute path of the verified staged tarball (outside browse roots). */
  stagedPath: string;
  protectionId: string;
  /** Snapshot id — the fixed object key derives from it. */
  snapshotId: string;
  /** Resolved destination: null = server-local archive, else a resolved
   *  backend plus its bucket (required for s3 kind). */
  destination: { backend: ResolvedAppBackend; s3Bucket: string } | null;
}

export interface PublishResult {
  /** Backend-relative object key for backend snapshots; null for
   *  server-local (archive_path is the BACKUP_DIR-relative path). */
  objectKey: string | null;
  /** BACKUP_DIR-relative path for server-local snapshots. */
  localRelPath: string | null;
  sizeBytes: number;
  checksumSha256: string;
}

export class AppStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppStorageError";
  }
}

/** True when an absolute path is contained within (or equals) a root. */
function containedIn(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== ".." && !rel.startsWith("../");
}

/** Publish the verified staged file to the snapshot's destination. Does not
 *  touch the DB. The caller owns snapshot-row insertion + compensation. */
export async function publishSnapshotArchive(input: PublishInput): Promise<PublishResult> {
  const sizeBytes = (await Bun.file(input.stagedPath).stat()).size;
  const buf = Buffer.from(await Bun.file(input.stagedPath).arrayBuffer());
  const checksumSha256 = createHash("sha256").update(buf).digest("hex");
  if (input.destination === null) {
    // Server-local: atomically rename into the historical layout
    // `<BACKUP_DIR>/apps/<protectionId>/<timestamp>-<uuid>.tar.gz`.
    const backupDir = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
    const timestamp = Date.now();
    const filename = `${timestamp}-${input.snapshotId}.tar.gz`;
    const relPath = join("apps", input.protectionId, filename);
    const fullPath = resolve(join(backupDir, relPath));
    if (!containedIn(backupDir, fullPath)) {
      throw new AppStorageError(`refusing to write outside backup root: ${relPath}`);
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    try {
      renameSync(input.stagedPath, fullPath);
    } catch {
      // rename across devices — fall back to copy + unlink.
      copyFileSync(input.stagedPath, fullPath);
      try {
        unlinkSync(input.stagedPath);
      } catch {
        /* staged cleanup is also handled by the caller's finally */
      }
    }
    return { objectKey: null, localRelPath: relPath, sizeBytes, checksumSha256 };
  }
  // Backend destination: fixed key lamasync/apps/<protectionId>/<snapshotId>.tar.gz.
  const objectKey = appObjectKey(input.protectionId, input.snapshotId);
  const { backend } = input.destination;
  if (backend.row.kind === "s3") {
    const bucket = input.destination.s3Bucket.trim();
    if (bucket === "") {
      throw new AppStorageError("s3 backend snapshots require a bucket");
    }
    const config = backend.s3Config;
    if (config === null) {
      throw new AppStorageError("s3 backend credentials are incomplete");
    }
    const remotePath = `${bucket}/${objectKey}`;
    await withTempRcloneConfig(config, async (configPath) => {
      const run = await runRclone([
        "rclone",
        "copyto",
        input.stagedPath,
        `relay:${remotePath}`,
        "--config",
        configPath,
        "--timeout",
        "120s",
      ]);
      if (run.code !== 0) {
        const detail = run.stderr.trim().split("\n").pop() ?? "rclone copyto failed";
        throw new AppStorageError(`relay to s3 backend failed: ${detail}`);
      }
    });
    return { objectKey, localRelPath: null, sizeBytes, checksumSha256 };
  }
  // local / nfs: direct server-side copy under the backend's absolute path.
  const localPath = backend.localPath!;
  const fullPath = resolve(join(localPath, objectKey));
  if (!containedIn(localPath, fullPath)) {
    throw new AppStorageError(`refusing to write outside backend path: ${objectKey}`);
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  copyFileSync(input.stagedPath, fullPath);
  return { objectKey, localRelPath: null, sizeBytes, checksumSha256 };
}

/**
 * Published-object compensation on DB failure: best-effort remove the
 * just-published object so a failed row insert cannot orphan the archive.
 * The caller reports cleanup failure operationally (this never throws).
 */
export async function compensatePublishedObject(
  db: Database,
  result: PublishResult,
  destination: { backendId: string; s3Bucket: string | null } | null,
): Promise<void> {
  const location: SnapshotLocation =
    destination === null
      ? { backendId: null, objectKey: null, s3Bucket: null, localRelPath: result.localRelPath ?? "" }
      : {
          backendId: destination.backendId,
          objectKey: result.objectKey ?? "",
          s3Bucket: destination.s3Bucket,
          localRelPath: "",
        };
  const outcome = await deleteSnapshotArchive(db, location);
  if (outcome.status === "failed") {
    console.error(
      `[app-storage] compensation delete failed for ${location.backendId ?? "server"} ${location.objectKey ?? location.localRelPath}: ${outcome.error}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Download + delete dispatch from the snapshot's STORED location.
// ---------------------------------------------------------------------------

export type SnapshotDownload =
  | { kind: "file"; absPath: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array>; run: Promise<RcloneRun> };

/** Resolve the download source for a stored snapshot location. Never falls
 *  back to a different backend: an unresolvable stored location throws.
 *  Callers stream the returned bytes to the client and await `run` for
 *  failure detection. */
export async function snapshotDownload(
  db: Database,
  location: SnapshotLocation,
): Promise<SnapshotDownload> {
  if (location.backendId === null) {
    const backupDir = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
    const fullPath = resolve(join(backupDir, location.localRelPath));
    if (!containedIn(backupDir, fullPath)) {
      throw new AppStorageError(`refusing to read outside backup root: ${location.localRelPath}`);
    }
    if (!existsSync(fullPath)) {
      throw new AppStorageError("snapshot archive not found");
    }
    return { kind: "file", absPath: fullPath };
  }
  const resolved = resolveAppBackend(db, location.backendId);
  if (resolved === null) {
    throw new AppStorageError(
      `snapshot backend ${location.backendId} is missing, invalid, or of an unallowed kind`,
    );
  }
  if (resolved.row.kind === "s3") {
    const config = resolved.s3Config;
    const key = location.objectKey;
    const bucket = location.s3Bucket ?? "";
    if (config === null || key === null || bucket === "") {
      throw new AppStorageError("snapshot s3 location is incomplete");
    }
    return catRemoteS3(config, `${bucket}/${key}`).then((r) => ({ kind: "stream", ...r }));
  }
  // local / nfs
  const key = location.objectKey;
  if (key === null) {
    throw new AppStorageError("snapshot has no stored object key");
  }
  const localPath = resolved.localPath!;
  const fullPath = resolve(join(localPath, key));
  if (!containedIn(localPath, fullPath)) {
    throw new AppStorageError(`refusing to read outside backend path: ${key}`);
  }
  if (!existsSync(fullPath)) {
    throw new AppStorageError("snapshot archive not found");
  }
  return { kind: "file", absPath: fullPath };
}

export type SnapshotDeleteOutcome =
  | { status: "deleted" }
  | { status: "absent" }
  | { status: "failed"; error: string };

/**
 * Delete the archive at a snapshot's STORED location (LAMA-324 expose + the
 * LAMA-325 retention delete primitive). Dispatch is exact: an unresolvable
 * or missing backend fails closed — retention must NEVER mistake a skipped
 * deletion for a pruned snapshot.
 */
export async function deleteSnapshotArchive(
  db: Database,
  location: SnapshotLocation,
): Promise<SnapshotDeleteOutcome> {
  if (location.backendId === null) {
    const backupDir = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
    const fullPath = resolve(join(backupDir, location.localRelPath));
    if (!containedIn(backupDir, fullPath)) {
      return {
        status: "failed",
        error: `refusing to unlink outside backup root: ${location.localRelPath}`,
      };
    }
    try {
      unlinkSync(fullPath);
      return { status: "deleted" };
    } catch (err) {
      if (isENOENT(err)) return { status: "absent" };
      return { status: "failed", error: errorMessage(err) };
    }
  }
  const resolved = resolveAppBackend(db, location.backendId);
  if (resolved === null) {
    return {
      status: "failed",
      error: `backend ${location.backendId} is missing, invalid, or of an unallowed kind`,
    };
  }
  if (resolved.row.kind === "s3") {
    const config = resolved.s3Config;
    const key = location.objectKey;
    const bucket = location.s3Bucket ?? "";
    if (config === null || key === null || bucket === "") {
      return { status: "failed", error: "snapshot s3 location is incomplete" };
    }
    try {
      const outcome = await withTempRcloneConfig(config, async (configPath) => {
        return runRclone([
          "rclone",
          "deletefile",
          `relay:${bucket}/${key}`,
          "--config",
          configPath,
          "--timeout",
          "120s",
        ]);
      });
      if (outcome.code === 0) return { status: "deleted" };
      if (looksLikeNotFound(outcome.stderr)) return { status: "absent" };
      return {
        status: "failed",
        error: outcome.stderr.trim().split("\n").pop() ?? "rclone deletefile failed",
      };
    } catch (err) {
      return { status: "failed", error: errorMessage(err) };
    }
  }
  // local / nfs
  const key = location.objectKey;
  if (key === null) {
    return { status: "failed", error: "snapshot has no stored object key" };
  }
  const localPath = resolved.localPath!;
  const fullPath = resolve(join(localPath, key));
  if (!containedIn(localPath, fullPath)) {
    return { status: "failed", error: `refusing to unlink outside backend path: ${key}` };
  }
  try {
    unlinkSync(fullPath);
    return { status: "deleted" };
  } catch (err) {
    if (isENOENT(err)) return { status: "absent" };
    return { status: "failed", error: errorMessage(err) };
  }
}

/** Convenience: delete by snapshot row fields (retention + routes). */
export function deleteSnapshotArchiveForRow(
  db: Database,
  row: SnapshotLocationRow,
): Promise<SnapshotDeleteOutcome> {
  return deleteSnapshotArchive(db, locationForSnapshot(row));
}

function isENOENT(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}